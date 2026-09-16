import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openIsolatedDb, type Db } from "@/database/connection";
import { servedFilePolicy, isActiveContent } from "@/lib/content-safety";
import { GraphClient, DeliveryAmbiguousError, isDeliveryAmbiguous } from "@/integrations/microsoft/graph-client";
import { reconcileSentMessage, normalizeSubject } from "@/integrations/microsoft/reconcile";
import { acquireLock, renewLock, releaseLock, currentLock } from "@/database/repositories/locks";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent, listStaleWebhookEvents, getWebhookEvent } from "@/database/repositories/webhook-events";
import { validateOutboundRecipients, resolveContactId, configuredRecipients } from "@/agent/recipients";
import { recoverStaleActions, resolveAmbiguousAction, AMBIGUOUS_CODE } from "@/actions/recovery";
import { approveAndExecute, clearExecutors, proposeAction, registerExecutor } from "@/actions/engine";
import { createOutlookExecutors, loadOutgoingAttachments } from "@/actions/executors/outlook";
import { hitRateLimit, resetRateLimit, clearRateLimits, clientKey, LOGIN_RATE_LIMIT } from "@/security/rate-limit";
import { extractPdfText, EXTRACTION_TIMEOUT_MESSAGE } from "@/documents/extract-text";
import * as emails from "@/database/repositories/emails";
import * as actionsRepo from "@/database/repositories/actions";
import * as documentsRepo from "@/database/repositories/documents";
import { saveTokenSet } from "@/integrations/microsoft/token-store";
import { settingsSchema, type Contact } from "@/lib/config";
import type { StructuredClient } from "@/integrations/anthropic/structured";
import { resetEnvCache } from "@/lib/env";
import { privateRoot, ensureDir } from "@/lib/paths";
import { listHistory } from "@/database/repositories/history";
import { parseWebhook } from "@/integrations/whatsapp/webhook";
import { fakeFetch, json, message, noSleep } from "./helpers/fake-graph";
import { fakeWhatsapp, textWebhook } from "./helpers/fake-whatsapp";
import { makeTextPdf } from "./helpers/pdf-fixtures";

/** Le cookie de session est contrôlé par le test : aucune requête Next réelle n'est nécessaire. */
const sessionCookie = { value: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ema_session" && sessionCookie.value ? { name, value: sessionCookie.value } : undefined) }),
}));

const settings = settingsSchema.parse({ company: { name: "GOMU", userName: "Madjid", email: "moi@gomu.fr" } });
const contacts: Contact[] = [{ id: "nabila", name: "Nabila", email: "nabila@gomu.fr", role: "Comptabilité", internal: true }];

/* §2 — Restitution des documents : rien d'actif ne s'exécute dans l'origine EMA */

describe("Politique de restitution des fichiers archivés", () => {
  it("un PDF authentique est le seul contenu affiché en ligne", () => {
    const p = servedFilePolicy("devis.pdf", "application/pdf");
    expect(p.disposition).toBe("inline");
    expect(p.contentType).toBe("application/pdf");
    expect(p.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("HTML, SVG, XHTML, XML et .eml sont téléchargés et neutralisés", () => {
    for (const [name, mime] of [
      ["piege.html", "text/html"],
      ["piege.svg", "image/svg+xml"],
      ["piege.xhtml", "application/xhtml+xml"],
      ["piege.xml", "application/xml"],
      ["message.eml", "message/rfc822"],
    ] as const) {
      const p = servedFilePolicy(name, mime);
      expect(isActiveContent(name, mime)).toBe(true);
      expect(p.disposition).toBe("attachment");
      expect(p.contentType).toBe("application/octet-stream");
      expect(p.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(p.headers["content-security-policy"]).toContain("sandbox");
    }
  });

  it("un MIME anodin ne suffit pas à afficher un contenu actif ni un faux PDF", () => {
    // Extension active + MIME menteur : le contenu reste neutralisé.
    const svg = servedFilePolicy("logo.svg", "image/png");
    expect(svg.contentType).toBe("application/octet-stream");
    expect(svg.disposition).toBe("attachment");
    // MIME application/pdf mais extension HTML : jamais affiché en ligne.
    const faux = servedFilePolicy("facture.html", "application/pdf");
    expect(faux.disposition).toBe("attachment");
    expect(faux.contentType).toBe("application/octet-stream");
    // Une image reste une pièce jointe (aucun rendu dans l'origine EMA).
    expect(servedFilePolicy("photo.png", "image/png").disposition).toBe("attachment");
  });

  it("le nom de fichier ne peut ni injecter d'en-tête ni casser les guillemets", () => {
    const p = servedFilePolicy('fac"ture\r\nSet-Cookie: x=1.pdf', "application/pdf");
    const disposition = p.headers["content-disposition"] ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.match(/"/g)).toHaveLength(2); // uniquement les guillemets d'encadrement
    expect(p.filename.length).toBeLessThanOrEqual(150);
  });
});

describe("Route de téléchargement d'un document", () => {
  afterEach(() => {
    delete process.env.APP_PASSWORD;
    resetEnvCache();
  });

  it("refuse un accès non authentifié avant toute lecture de fichier", async () => {
    process.env.APP_PASSWORD = "mot-de-passe-interface-test";
    resetEnvCache();
    sessionCookie.value = undefined;
    const { GET } = await import("@/app/api/documents/[id]/file/route");
    const res = await GET(new Request("http://localhost/api/documents/doc-inexistant/file"), { params: Promise.resolve({ id: "doc-inexistant" }) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("session falsifiée : refus également (aucun fichier servi)", async () => {
    process.env.APP_PASSWORD = "mot-de-passe-interface-test";
    resetEnvCache();
    sessionCookie.value = "1758000000.signature-inventee";
    const { GET } = await import("@/app/api/documents/[id]/file/route");
    const res = await GET(new Request("http://localhost/api/documents/doc-1/file"), { params: Promise.resolve({ id: "doc-1" }) });
    expect(res.status).toBe(401);
    sessionCookie.value = undefined;
  });
});

/* §3 — Graph ne rejoue jamais un envoi à l'aveugle */

describe("Microsoft Graph : idempotence des envois", () => {
  const client = (fetchImpl: typeof fetch, over: { maxRetries?: number } = {}) =>
    new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep, maxRetries: over.maxRetries ?? 3 });

  it("panne réseau sur un GET : rejoué, puis erreur d'intégration", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        match: /GET .*\/messages/,
        handle: () => {
          throw new TypeError("fetch failed");
        },
      },
    ]);
    await expect(client(fetchImpl).get("/me/messages")).rejects.toMatchObject({ code: "INTEGRATION" });
    expect(calls.length).toBe(4); // 1 tentative + 3 reprises
  });

  it("panne réseau sur un envoi : une seule tentative, résultat ambigu", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        match: /POST .*\/sendMail/,
        handle: () => {
          throw new TypeError("fetch failed");
        },
      },
    ]);
    const err = await client(fetchImpl)
      .post("/me/sendMail", { message: {} })
      .catch((e: unknown) => e);
    expect(isDeliveryAmbiguous(err)).toBe(true);
    expect(err).toBeInstanceOf(DeliveryAmbiguousError);
    expect((err as DeliveryAmbiguousError).message).toMatch(/peut-être déjà envoyé/);
    expect(calls).toHaveLength(1);
  });

  it("503 sur un envoi : jamais rejoué, résultat ambigu", async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: /POST .*\/reply/, handle: () => json({ error: { code: "ServiceUnavailable" } }, 503) }]);
    const err = await client(fetchImpl)
      .post("/me/messages/g1/reply", { comment: "x" })
      .catch((e: unknown) => e);
    expect(isDeliveryAmbiguous(err)).toBe(true);
    expect((err as DeliveryAmbiguousError).httpStatus).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("503 sur une lecture : rejoué normalement", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch([
      {
        match: /GET .*\/messages/,
        handle: () => (++n < 3 ? json({ error: { code: "ServiceUnavailable" } }, 503) : json({ value: [] })),
      },
    ]);
    await expect(client(fetchImpl).get<{ value: unknown[] }>("/me/messages")).resolves.toEqual({ value: [] });
    expect(calls).toHaveLength(3);
  });

  it("429 sur un envoi : rejoué (la requête a été refusée avant traitement)", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch([
      {
        match: /POST .*\/sendMail/,
        handle: () => (++n === 1 ? json({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "1" }) : new Response(null, { status: 202 })),
      },
    ]);
    await expect(client(fetchImpl).post("/me/sendMail", { message: {} })).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("401 sur un envoi : token rafraîchi puis rejeu unique", async () => {
    let n = 0;
    let refreshes = 0;
    const { fetchImpl, calls } = fakeFetch([
      {
        match: /POST .*\/sendMail/,
        handle: () => (++n === 1 ? json({ error: { code: "InvalidAuthenticationToken" } }, 401) : new Response(null, { status: 202 })),
      },
    ]);
    const c = new GraphClient({
      getAccessToken: async () => "expiré",
      onUnauthorized: async () => {
        refreshes++;
        return "frais";
      },
      fetchImpl,
      sleep: noSleep,
    });
    await expect(c.post("/me/sendMail", { message: {} })).resolves.toBeUndefined();
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.authorization).toBe("Bearer frais");
  });
});

/* §4 — Réconciliation avec les éléments envoyés */

describe("Réconciliation Outlook avant toute nouvelle tentative", () => {
  const client = (fetchImpl: typeof fetch) => new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep, maxRetries: 0 });

  it("message retrouvé dans la conversation → verdict envoyé", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [message({ id: "s1", conversationId: "conv", sentDateTime: "2026-09-16T09:00:00Z" })] }) },
    ]);
    const r = await reconcileSentMessage(client(fetchImpl), { conversationId: "conv", since: "2026-09-16T08:00:00Z" });
    expect(r.verdict).toBe("sent");
    expect(r.message?.id).toBe("s1");
  });

  it("conversation vide → verdict non envoyé (nouvelle tentative possible)", async () => {
    const { fetchImpl } = fakeFetch([{ match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [] }) }]);
    const r = await reconcileSentMessage(client(fetchImpl), { conversationId: "conv", since: "2026-09-16T08:00:00Z" });
    expect(r.verdict).toBe("not_sent");
  });

  it("objet identique mais destinataire différent → inconnu, jamais « non envoyé »", async () => {
    const { fetchImpl } = fakeFetch([
      {
        match: /GET .*\/sentitems\/messages\?/,
        handle: () => json({ value: [message({ id: "s2", subject: "Règlement facture 42", toRecipients: [{ emailAddress: { address: "autre@gomu.fr" } }] })] }),
      },
    ]);
    const r = await reconcileSentMessage(client(fetchImpl), { subject: "RE: Règlement facture 42", to: ["nabila@gomu.fr"], since: "2026-09-16T08:00:00Z" });
    expect(r.verdict).toBe("unknown");
  });

  it("Graph illisible → inconnu (aucune conclusion à partir d'une lecture ratée)", async () => {
    const { fetchImpl } = fakeFetch([{ match: /GET .*\/sentitems/, handle: () => json({ error: { code: "ErrorAccessDenied" } }, 403) }]);
    const r = await reconcileSentMessage(client(fetchImpl), { conversationId: "conv", since: "2026-09-16T08:00:00Z" });
    expect(r.verdict).toBe("unknown");
    expect(r.detail).toMatch(/impossible/i);
  });

  it("normalise les objets (RE:, TR:, casse, espaces)", () => {
    expect(normalizeSubject("RE:  Devis   n°12")).toBe("devis n°12");
    expect(normalizeSubject("TR: RE: Devis n°12")).toBe("devis n°12");
  });
});

/* §5, §6, §9, §10 — Verrous, webhooks, reprise, limitation de débit */

describe("Verrous d'exécution du worker", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });

  it("un verrou actif n'est jamais repris, même par le même nom de tâche", () => {
    expect(acquireLock("scan", "worker-1:scan:run-a", 60, db)).toBe(true);
    expect(acquireLock("scan", "worker-1:scan:run-b", 60, db)).toBe(false);
    // Même chaîne d'owner : toujours refusé (plus de réentrance).
    expect(acquireLock("scan", "worker-1:scan:run-a", 60, db)).toBe(false);
    expect(currentLock("scan", db)?.owner).toBe("worker-1:scan:run-a");
  });

  it("un verrou expiré est repris, un verrou libéré aussi", () => {
    expect(acquireLock("scan", "run-a", -1, db)).toBe(true);
    expect(acquireLock("scan", "run-b", 60, db)).toBe(true);
    expect(currentLock("scan", db)?.owner).toBe("run-b");
    releaseLock("scan", "run-b", db);
    expect(currentLock("scan", db)).toBeNull();
  });

  it("renouvellement : seul le détenteur prolonge son verrou", () => {
    acquireLock("scan", "run-a", 1, db);
    expect(renewLock("scan", "run-b", 60, db)).toBe(false);
    expect(renewLock("scan", "run-a", 60, db)).toBe(true);
    expect(acquireLock("scan", "run-c", 60, db)).toBe(false);
  });
});

describe("Cycle de traitement d'un événement entrant", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });

  const claim = (id: string, ttl?: number) => claimWebhookEvent({ provider: "whatsapp", externalId: id, eventType: "text", sender: "33•••678", ttlSeconds: ttl }, db);

  it("RECEIVED → PROCESSING → PROCESSED : un doublon n'est jamais retraité", () => {
    const first = claim("wamid.1");
    expect(first.claimed).toBe(true);
    expect(first.claimed && first.resumed).toBe(false);
    const concurrent = claim("wamid.1");
    expect(concurrent.claimed).toBe(false);
    expect(!concurrent.claimed && concurrent.reason).toBe("in_progress");
    completeWebhookEvent("whatsapp", "wamid.1", "chat_reply", db);
    const later = claim("wamid.1");
    expect(later.claimed).toBe(false);
    expect(!later.claimed && later.reason).toBe("already_processed");
    expect(getWebhookEvent("whatsapp", "wamid.1", db)?.status).toBe("PROCESSED");
  });

  it("échec : l'événement reste reprenable et la reprise est signalée", () => {
    claim("wamid.2");
    failWebhookEvent("whatsapp", "wamid.2", "Claude indisponible", db);
    const again = claim("wamid.2");
    expect(again.claimed).toBe(true);
    expect(again.claimed && again.resumed).toBe(true);
    expect(again.event.attempts).toBe(2);
  });

  it("crash pendant le traitement : le verrou expire, l'événement redevient reprenable", () => {
    claim("wamid.3", -1); // verrou déjà expiré : simule un process mort
    expect(listStaleWebhookEvents(10, db).map((e) => e.external_id)).toContain("wamid.3");
    const resumed = claim("wamid.3");
    expect(resumed.claimed).toBe(true);
    expect(resumed.claimed && resumed.resumed).toBe(true);
  });
});

describe("Limitation des tentatives de connexion", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    clearRateLimits(db);
  });
  afterEach(() => resetEnvCache());

  it("5 tentatives autorisées, la 6e bloque pendant 15 minutes", () => {
    const t0 = Date.parse("2026-09-16T10:00:00Z");
    for (let i = 1; i <= LOGIN_RATE_LIMIT.max; i++) {
      const r = hitRateLimit("login:global", LOGIN_RATE_LIMIT, t0 + i * 1000, db);
      expect(r.allowed).toBe(true);
    }
    const blocked = hitRateLimit("login:global", LOGIN_RATE_LIMIT, t0 + 6000, db);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(800);
    // Toujours bloqué 10 minutes plus tard, y compris après redémarrage (état en base).
    expect(hitRateLimit("login:global", LOGIN_RATE_LIMIT, t0 + 10 * 60_000, db).allowed).toBe(false);
    // Débloqué après la fenêtre de blocage.
    expect(hitRateLimit("login:global", LOGIN_RATE_LIMIT, t0 + 16 * 60_000, db).allowed).toBe(true);
  });

  it("une connexion réussie réinitialise le compteur", () => {
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) hitRateLimit("login:global", LOGIN_RATE_LIMIT, t0, db);
    resetRateLimit("login:global", db);
    expect(hitRateLimit("login:global", LOGIN_RATE_LIMIT, t0, db).remaining).toBe(LOGIN_RATE_LIMIT.max - 1);
  });

  it("X-Forwarded-For n'est pris en compte que si le proxy est déclaré de confiance", () => {
    const req = new Request("http://localhost/api/auth/login", { headers: { "x-forwarded-for": "1.2.3.4" } });
    process.env.TRUST_PROXY_HEADER = "false";
    resetEnvCache();
    expect(clientKey(req)).toBe("login:global");
    process.env.TRUST_PROXY_HEADER = "true";
    resetEnvCache();
    expect(clientKey(req)).toBe("login:1.2.3.4");
    delete process.env.TRUST_PROXY_HEADER;
    resetEnvCache();
  });
});

/* §7 et §8 — Destinataires déterministes */

describe("Destinataires sortants", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });

  it("un contact configuré est résolu, un contact inconnu est refusé sans adresse inventée", () => {
    expect(resolveContactId("nabila", { db, contacts, settings }).email).toBe("nabila@gomu.fr");
    expect(() => resolveContactId("le comptable", { db, contacts, settings })).toThrow(/inconnu/);
    expect(() => resolveContactId("pirate@ailleurs.fr", { db, contacts, settings })).toThrow(/Aucune adresse n'est inventée/);
  });

  it("un correspondant réel de la boîte est accepté, une adresse inventée non", () => {
    emails.insertEmail({ graphId: "g1", threadId: "conv", senderEmail: "client@ext.fr", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    expect(resolveContactId("mailbox:client@ext.fr", { db, contacts, settings }).email).toBe("client@ext.fr");
    expect(() => resolveContactId("mailbox:inconnu@pirate.fr", { db, contacts, settings })).toThrow(/inconnu/);
  });

  it("validateOutboundRecipients : contact et boîte du client autorisés, adresse arbitraire refusée", () => {
    expect(configuredRecipients({ db, contacts, settings, rules: [] })).toContain("nabila@gomu.fr");
    expect(() => validateOutboundRecipients(["nabila@gomu.fr"], { db, contacts, settings, rules: [] })).not.toThrow();
    expect(() => validateOutboundRecipients(["MOI@GOMU.FR"], { db, contacts, settings, rules: [] })).not.toThrow();
    expect(() => validateOutboundRecipients(["pirate@ailleurs.fr"], { db, contacts, settings, rules: [] })).toThrow(/Destinataire non autorisé/);
    expect(() => validateOutboundRecipients([], { db, contacts, settings, rules: [] })).toThrow(/Aucun destinataire/);
  });

  it("un destinataire du thread reste autorisé, y compris en copie", () => {
    const e = emails.insertEmail({ graphId: "g2", threadId: "c2", senderEmail: "client@ext.fr", toRecipients: ["moi@gomu.fr"], ccRecipients: ["assistante@ext.fr"], subject: "x", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    expect(() => validateOutboundRecipients(["assistante@ext.fr"], { db, contacts, settings, rules: [], threadEmail: e })).not.toThrow();
    expect(() => validateOutboundRecipients(["client@ext.fr"], { db, contacts, settings, rules: [], threadEmail: e })).not.toThrow();
  });
});

/* §12 — Pièces jointes sortantes */

describe("Pièces jointes sortantes", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    clearExecutors();
  });
  afterEach(() => {
    clearExecutors();
    delete process.env.OUTGOING_ATTACHMENT_MAX_MB;
    resetEnvCache();
  });

  it("au-delà de la limite, l'envoi est refusé AVANT tout appel à Graph", async () => {
    process.env.OUTGOING_ATTACHMENT_MAX_MB = "0.2"; // 200 Ko
    resetEnvCache();
    const dir = path.join(privateRoot(), "documents", "2026", "09");
    ensureDir(dir);
    const file = path.join(dir, "gros-devis.pdf");
    fs.writeFileSync(file, Buffer.alloc(500 * 1024, 1));
    const e = emails.insertEmail({ graphId: "g-att", threadId: "conv-att", senderEmail: "client@ext.fr", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const doc = documentsRepo.insertDocument({ emailId: e.id, name: "gros-devis.pdf", mimeType: "application/pdf", size: 500 * 1024, originalPath: "documents/2026/09/gros-devis.pdf", sha256: "x".repeat(64) }, db);

    expect(() => loadOutgoingAttachments([doc.id], db)).toThrow(/trop volumineuse/);

    const { fetchImpl, calls } = fakeFetch([{ match: /POST .*\/reply$/, handle: () => new Response(null, { status: 202 }) }]);
    saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@gomu.fr", db);
    for (const ex of createOutlookExecutors({ db, client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), contacts, settings })) registerExecutor(ex);
    const a = proposeAction({ type: "reply_email", title: "Répondre avec pièce jointe", payload: { email_id: e.id, body: "Voici le devis.", attachments: [doc.id] }, sourceEmailId: e.id }, { db, settings });
    const done = await approveAndExecute(a.id, "user", { db, settings });
    expect(done.status).toBe("FAILED");
    expect(done.error).toMatch(/trop volumineuse|Envoi manuel/);
    expect(calls).toHaveLength(0);
    fs.rmSync(file, { force: true });
  });
});

/* §9 — Reprise après interruption */

describe("Reprise des actions interrompues", () => {
  let db: Db;
  const graph = (routes: Parameters<typeof fakeFetch>[0]) => new GraphClient({ getAccessToken: async () => "t", fetchImpl: fakeFetch(routes).fetchImpl, sleep: noSleep, maxRetries: 0 });
  const old = new Date(Date.now() - 60 * 60_000).toISOString();

  beforeEach(() => {
    db = openIsolatedDb();
    clearExecutors();
    saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@gomu.fr", db);
  });
  afterEach(() => clearExecutors());

  function stale(status: "APPROVED" | "EXECUTING", type = "reply_email"): { id: string; emailId: string } {
    const e = emails.insertEmail({ graphId: `g-${status}-${Math.random()}`, threadId: "conv-r", senderEmail: "client@ext.fr", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const a = proposeAction({ type: type as "reply_email", title: "Répondre", payload: { email_id: e.id, body: "Bonjour" }, sourceEmailId: e.id }, { db, settings });
    actionsRepo.transitionAction(a.id, ["WAITING_APPROVAL"], "APPROVED", { approved_at: old }, db);
    if (status === "EXECUTING") actionsRepo.transitionAction(a.id, ["APPROVED"], "EXECUTING", { executed_at: old }, db);
    return { id: a.id, emailId: e.id };
  }

  it("validée mais jamais exécutée : l'action repart normalement", async () => {
    const { id } = stale("APPROVED");
    let sent = 0;
    registerExecutor({
      type: "reply_email",
      execute: async () => {
        sent++;
        return { ok: true, summary: "Réponse envoyée" };
      },
    });
    const report = await recoverStaleActions({ db, settings, client: null });
    expect(report.resumed).toContain(id);
    expect(sent).toBe(1);
    expect(actionsRepo.getAction(id, db)?.status).toBe("COMPLETED");
  });

  it("interrompue en cours d'envoi et message retrouvé : terminée sans second envoi", async () => {
    const { id } = stale("EXECUTING");
    let sent = 0;
    registerExecutor({
      type: "reply_email",
      execute: async () => {
        sent++;
        return { ok: true, summary: "Réponse envoyée" };
      },
    });
    const client = graph([{ match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [message({ id: "s9", conversationId: "conv-r", sentDateTime: new Date().toISOString() })] }) }]);
    const report = await recoverStaleActions({ db, settings, client });
    expect(report.reconciled).toContain(id);
    expect(sent).toBe(0);
    expect(actionsRepo.getAction(id, db)?.status).toBe("COMPLETED");
  });

  it("interrompue et vérification impossible : échec explicite, jamais de renvoi", async () => {
    const { id } = stale("EXECUTING");
    const report = await recoverStaleActions({ db, settings, client: null }); // Outlook indisponible
    expect(report.ambiguous).toContain(id);
    const action = actionsRepo.getAction(id, db);
    expect(action?.status).toBe("FAILED");
    expect(action?.error_code).toBe(AMBIGUOUS_CODE);
    expect(action?.error).toMatch(/Vérification humaine requise/);
  });

  it("aucun envoi retrouvé : l'action est rejouable explicitement", async () => {
    const { id } = stale("EXECUTING");
    const client = graph([{ match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [] }) }]);
    const outcome = await resolveAmbiguousAction(id, { db, settings, client });
    expect(outcome.verdict).toBe("not_sent");
    expect(actionsRepo.getAction(id, db)?.error_code).toBe("NOT_SENT");
  });

  it("un devis déjà signé n'est jamais re-signé pendant la reprise", async () => {
    const e = emails.insertEmail({ graphId: "g-sign", threadId: "conv-sign", senderEmail: "client@ext.fr", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const original = documentsRepo.insertDocument({ emailId: e.id, name: "devis.pdf", mimeType: "application/pdf", size: 1000, originalPath: "documents/2026/09/devis.pdf", sha256: "a".repeat(64) }, db);
    const signed = documentsRepo.insertDocument({ emailId: e.id, name: "devis-signe.pdf", mimeType: "application/pdf", size: 1200, originalPath: "signed-documents/2026/09/devis-signe.pdf", sha256: "b".repeat(64), parentDocumentId: original.id }, db);
    documentsRepo.updateDocument(original.id, { signed_document_id: signed.id, signed_path: "signed-documents/2026/09/devis-signe.pdf" }, db);
    const a = proposeAction({ type: "sign_document", title: "Signer le devis", payload: { document_id: original.id, company_id: "gomu83", email_id: e.id, reply_body: "Voici le devis signé." }, sourceEmailId: e.id, documentId: original.id }, { db, settings });
    actionsRepo.transitionAction(a.id, ["WAITING_APPROVAL"], "APPROVED", { approved_at: old }, db);
    actionsRepo.transitionAction(a.id, ["APPROVED"], "EXECUTING", { executed_at: old }, db);
    let signatures = 0;
    registerExecutor({
      type: "sign_document",
      execute: async () => {
        signatures++;
        return { ok: true, summary: "signé" };
      },
    });
    const client = graph([{ match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [message({ id: "s10", conversationId: "conv-sign", sentDateTime: new Date().toISOString() })] }) }]);
    await recoverStaleActions({ db, settings, client });
    expect(signatures).toBe(0);
    expect(documentsRepo.getDocument(original.id, db)?.signed_document_id).toBe(signed.id);
  });
});

describe("Message WhatsApp interrompu", () => {
  let db: Db;
  const APPROVER = "33612345678";

  beforeEach(() => {
    db = openIsolatedDb();
  });

  it("un message déjà enregistré avant un crash n'est jamais rejoué : aucune seconde action", async () => {
    const { handleWhatsappEvent } = await import("@/integrations/whatsapp/router");
    const chatRepo = await import("@/database/repositories/chat");
    const messageId = "wamid.interrompu";
    // État laissé par le crash : message enregistré, événement bloqué en PROCESSING, verrou expiré.
    chatRepo.insertMessage({ role: "user", content: "Envoie le devis à Nabila", channel: "WHATSAPP", externalId: messageId, sender: "33•••678" }, db);
    claimWebhookEvent({ provider: "whatsapp", externalId: messageId, eventType: "text", sender: "33•••678", ttlSeconds: -1 }, db);

    const wa = fakeWhatsapp();
    let llmCalls = 0;
    const anthropic = {
      messages: {
        create: async () => {
          llmCalls++;
          throw new Error("Claude ne doit pas être rappelé sur un message interrompu");
        },
        parse: async () => {
          llmCalls++;
          throw new Error("Claude ne doit pas être rappelé sur un message interrompu");
        },
      },
    } as unknown as StructuredClient;

    const event = parseWebhook(textWebhook(APPROVER, "Envoie le devis à Nabila", messageId))[0]!;
    const result = await handleWhatsappEvent(event, { db, settings, client: wa.client, anthropic, approverPhone: APPROVER, assistantEnabled: true });

    expect(result.outcome).toBe("interrupted");
    expect(llmCalls).toBe(0);
    expect(actionsRepo.listActions({ limit: 50 }, db)).toHaveLength(0);
    expect(result.reply).toMatch(/interruption/i);
    expect(getWebhookEvent("whatsapp", messageId, db)?.status).toBe("PROCESSED");
    expect(listHistory({ limit: 20 }, db).some((h) => h.event_type === "whatsapp.interrupted")).toBe(true);
    // Le même message renvoyé plus tard est un doublon : toujours pas de seconde action.
    const again = await handleWhatsappEvent(event, { db, settings, client: wa.client, anthropic, approverPhone: APPROVER, assistantEnabled: true });
    expect(again.outcome).toBe("duplicate");
    expect(actionsRepo.listActions({ limit: 50 }, db)).toHaveLength(0);
  });
});

/* §11 — Sauvegarde chiffrée */

describe("Sauvegarde chiffrée (scrypt + AES-256-GCM)", () => {
  const script = path.resolve("scripts/backup-crypto.cjs");
  let dir: string;
  const PASSWORD = "mot-de-passe-de-test-16"; // jamais un secret réel

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ema-backup-test-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], password: string | undefined = PASSWORD) =>
    execFileSync(process.execPath, [script, ...args], { env: { ...process.env, BACKUP_ENCRYPTION_PASSWORD: password ?? "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("chiffre puis déchiffre à l'identique, sans laisser le contenu en clair", () => {
    const plain = path.join(dir, "archive.tar.gz");
    const content = Buffer.from("facture client 42 — donnée confidentielle");
    fs.writeFileSync(plain, content);
    run(["encrypt", plain, `${plain}.enc`]);
    const encrypted = fs.readFileSync(`${plain}.enc`);
    expect(encrypted.subarray(0, 6).toString()).toBe("EMABK1");
    expect(encrypted.includes("facture client 42")).toBe(false);
    expect((fs.statSync(`${plain}.enc`).mode & 0o777).toString(8)).toBe("600");
    run(["decrypt", `${plain}.enc`, path.join(dir, "out.tar.gz")]);
    expect(fs.readFileSync(path.join(dir, "out.tar.gz")).equals(content)).toBe(true);
  });

  it("mot de passe incorrect ou archive altérée : refus, sans écrire de sortie", () => {
    const plain = path.join(dir, "a.tar.gz");
    fs.writeFileSync(plain, "données");
    run(["encrypt", plain, `${plain}.enc`]);
    expect(() => run(["decrypt", `${plain}.enc`, path.join(dir, "ko.tar.gz")], "autre-mot-de-passe-long")).toThrow();
    expect(fs.existsSync(path.join(dir, "ko.tar.gz"))).toBe(false);

    const tampered = fs.readFileSync(`${plain}.enc`);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    fs.writeFileSync(path.join(dir, "altere.enc"), tampered);
    expect(() => run(["decrypt", path.join(dir, "altere.enc"), path.join(dir, "ko2.tar.gz")])).toThrow();
    expect(fs.existsSync(path.join(dir, "ko2.tar.gz"))).toBe(false);
  });

  it("mot de passe absent ou trop court : chiffrement refusé, sans jamais l'afficher", () => {
    const plain = path.join(dir, "b.tar.gz");
    fs.writeFileSync(plain, "données");
    let output = "";
    try {
      execFileSync(process.execPath, [script, "encrypt", plain, `${plain}.enc`], { env: { ...process.env, BACKUP_ENCRYPTION_PASSWORD: "court" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      output = String((err as { stderr?: string }).stderr ?? "");
    }
    expect(output).toMatch(/trop court/);
    expect(output).not.toContain("court\n");
    expect(fs.existsSync(`${plain}.enc`)).toBe(false);
  });
});

describe("scripts/backup.sh : chiffrement de bout en bout", () => {
  let root: string;

  /** Squelette d'installation EMA (scripts réels, node_modules partagé, aucune donnée réelle). */
  function install(envLines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ema-enc-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.mkdirSync(path.join(dir, "config"));
    fs.mkdirSync(path.join(dir, "private", "documents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scripts"));
    for (const f of ["backup.sh", "restore.sh", "db-snapshot.cjs", "backup-crypto.cjs"]) fs.copyFileSync(path.join("scripts", f), path.join(dir, "scripts", f));
    fs.copyFileSync("package.json", path.join(dir, "package.json"));
    fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "dir");
    fs.writeFileSync(path.join(dir, ".env"), [...envLines, ""].join("\n"));
    fs.writeFileSync(path.join(dir, "config", "settings.json"), JSON.stringify({ version: 1 }));
    fs.writeFileSync(path.join(dir, "private", "documents", "facture.pdf"), "%PDF-1.4 donnée client");
    return dir;
  }

  const base = ["DATABASE_PATH=./data/ema.db", "PRIVATE_STORAGE_PATH=./private", "CONFIG_PATH=./config"];

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("avec un secret : archive chiffrée en 600, aucun fichier en clair, restauration complète", () => {
    root = install([...base, "BACKUP_ENCRYPTION_PASSWORD=sauvegarde-test-2026"]);
    execFileSync("bash", ["scripts/backup.sh"], { cwd: root, encoding: "utf8" });
    const files = fs.readdirSync(path.join(root, "backups"));
    expect(files.filter((f) => f.endsWith(".tar.gz"))).toHaveLength(0); // aucune archive en clair conservée
    const archives = files.filter((f) => f.endsWith(".tar.gz.enc"));
    expect(archives).toHaveLength(1);
    const archive = path.join(root, "backups", archives[0] as string);
    expect((fs.statSync(archive).mode & 0o777).toString(8)).toBe("600");
    const raw = fs.readFileSync(archive);
    expect(raw.subarray(0, 6).toString()).toBe("EMABK1");
    expect(raw.includes("donnée client")).toBe(false);

    fs.rmSync(path.join(root, "private", "documents"), { recursive: true, force: true });
    const out = execFileSync("bash", ["scripts/restore.sh", archive], { cwd: root, encoding: "utf8" });
    expect(out).toContain("déchiffrée dans un dossier temporaire");
    expect(fs.readFileSync(path.join(root, "private", "documents", "facture.pdf"), "utf8")).toBe("%PDF-1.4 donnée client");
    // Le déchiffrement temporaire ne laisse rien derrière lui.
    expect(fs.readdirSync(os.tmpdir()).some((f) => f.startsWith("tmp") && fs.existsSync(path.join(os.tmpdir(), f, "source.tar.gz")))).toBe(false);
    expect(fs.existsSync(archive)).toBe(true);
  });

  it("mauvais mot de passe : la restauration s'arrête sans toucher à l'installation", () => {
    root = install([...base, "BACKUP_ENCRYPTION_PASSWORD=sauvegarde-test-2026"]);
    execFileSync("bash", ["scripts/backup.sh"], { cwd: root, encoding: "utf8" });
    const archive = path.join(root, "backups", fs.readdirSync(path.join(root, "backups")).find((f) => f.endsWith(".enc")) as string);
    fs.writeFileSync(path.join(root, ".env"), [...base, "BACKUP_ENCRYPTION_PASSWORD=un-autre-mot-de-passe", ""].join("\n"));
    fs.writeFileSync(path.join(root, "private", "documents", "facture.pdf"), "état courant");
    expect(() => execFileSync("bash", ["scripts/restore.sh", archive], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).toThrow();
    expect(fs.readFileSync(path.join(root, "private", "documents", "facture.pdf"), "utf8")).toBe("état courant");
  });

  it("production sans secret : la sauvegarde en clair est refusée, sauf option explicite", () => {
    root = install([...base, "NODE_ENV=production"]);
    let stderr = "";
    try {
      execFileSync("bash", ["scripts/backup.sh"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? "");
    }
    expect(stderr).toMatch(/BACKUP_ENCRYPTION_PASSWORD absent en production/);
    expect(fs.existsSync(path.join(root, "backups")) ? fs.readdirSync(path.join(root, "backups")).filter((f) => f.startsWith("ema-backup-")) : []).toHaveLength(0);

    const out = execFileSync("bash", ["scripts/backup.sh", path.join(root, "backups"), "--allow-plaintext"], { cwd: root, encoding: "utf8" });
    expect(out).toContain("Sauvegarde créée");
    expect(fs.readdirSync(path.join(root, "backups")).filter((f) => f.endsWith(".tar.gz"))).toHaveLength(1);
  });
});

/* §13 — Extraction PDF réellement interruptible */

describe("Extraction PDF", () => {
  it("dépassement du délai : l'extraction est interrompue avec un message exploitable", async () => {
    const pdf = await makeTextPdf(["Devis n°12", "Total 1 200 €"]);
    await expect(extractPdfText(pdf, 0.001)).rejects.toThrow(EXTRACTION_TIMEOUT_MESSAGE);
  });

  it("un fichier non PDF est refusé avant tout traitement", async () => {
    await expect(extractPdfText(Buffer.from("<html><script>alert(1)</script></html>"), 5)).rejects.toThrow(/n'est pas un PDF/);
  });
});
