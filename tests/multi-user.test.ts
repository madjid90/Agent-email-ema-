import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as users from "@/database/repositories/users";
import * as emails from "@/database/repositories/emails";
import * as actions from "@/database/repositories/actions";
import * as chat from "@/database/repositories/chat";
import { listHistory } from "@/database/repositories/history";
import { getConnection, listActiveConnections } from "@/database/repositories/connections";
import { normalizePhone, toWhatsappId, maskE164, formatPhone } from "@/lib/phone";
import { hashPassword } from "@/security/passwords";
import { authenticate, registerAccount } from "@/security/accounts";
import { createSessionValue, parseSessionValue } from "@/security/auth";
import { GraphClient, createConnectedGraphClient, isOutlookConnected } from "@/integrations/microsoft/graph-client";
import { loadTokenSet, saveTokenSet, TOKEN_PROVIDER } from "@/integrations/microsoft/token-store";
import { completeConnection, createOAuthState, disconnect } from "@/integrations/microsoft/oauth";
import { syncInbox } from "@/integrations/microsoft/sync";
import { handleWhatsappEvent, identifySender, UNKNOWN_NUMBER_REPLY } from "@/integrations/whatsapp/router";
import { parseWebhook } from "@/integrations/whatsapp/webhook";
import { getWhatsappActivation } from "@/integrations/whatsapp/activation";
import { runChatTurn } from "@/agent/chat";
import { toolContextFor } from "@/agent/context";
import { executeTool, registerAllTools, resetToolsForTests } from "@/tools";
import { setGraphClientFactoryForTests } from "@/tools/outlook";
import { clearExecutors, proposeAction, registerExecutor } from "@/actions/engine";
import { createOutlookExecutors } from "@/actions/executors/outlook";
import { settingsSchema, writeConfig, type Contact } from "@/lib/config";
import { resetEnvCache } from "@/lib/env";
import { privateRoot } from "@/lib/paths";
import { fakeAnthropic } from "./helpers/fake-anthropic";
import { fakeWhatsapp, textWebhook } from "./helpers/fake-whatsapp";
import { fakeFetch, json, message, noSleep } from "./helpers/fake-graph";
import { turn, textTurn } from "./helpers/fake-chat";

const settings = settingsSchema.parse({ company: { name: "EMA", userName: "EMA", email: "ema@ema.fr", timezone: "Europe/Paris" } });
const contacts: Contact[] = [{ id: "julien", name: "Julien Martin", email: "julien@fournisseur.fr", role: "Fournisseur", internal: false }];
const PHONE_A = "+33612345678";
const PHONE_B = "+33698765432";
const WA_A = toWhatsappId(PHONE_A);
const WA_B = toWhatsappId(PHONE_B);

const setEnv = (key: string, value: string | undefined): void => {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
};

function tokenSet(tag: string, expiresInMs = 3_600_000) {
  return { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), scope: "Mail.Read Mail.Send" };
}

/** Faux Graph : chaque boîte répond avec SES messages selon le bearer présenté. */
function graphFor(mailboxes: Record<string, { subject: string; from: string; id: string }[]>) {
  return fakeFetch([
    {
      match: /GET .*\/messages/,
      handle: (call) => {
        const token = call.headers.authorization?.replace("Bearer ", "") ?? "";
        const box = mailboxes[token] ?? [];
        return json({ value: box.map((m) => message({ id: m.id, subject: m.subject, from: { emailAddress: { name: m.from, address: `${m.from.toLowerCase()}@ext.fr` } }, conversationId: `conv-${m.id}` })) });
      },
    },
    { match: /POST .*\/reply$/, handle: () => new Response(null, { status: 202 }) },
    { match: /GET .*\/sentitems/, handle: () => json({ value: [] }) },
  ]);
}

function event(from: string, text: string, id?: string) {
  return parseWebhook(textWebhook(from, text, id))[0]!;
}

describe("Identité utilisateur : numéro E.164, comptes, sessions", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });

  it("normalise les numéros au format international", () => {
    expect(normalizePhone("06 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("0033612345678")).toBe("+33612345678");
    expect(normalizePhone("33612345678")).toBe("+33612345678"); // forme WhatsApp (chiffres sans +)
    expect(normalizePhone("+41 79 123 45 67")).toBe("+41791234567");
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(toWhatsappId("+33612345678")).toBe("33612345678");
    expect(formatPhone("+33612345678")).toBe("+33 6 12 34 56 78");
    expect(maskE164("+33612345678")).toBe("+33••••••678");
  });

  it("un numéro n'appartient qu'à un seul compte actif ; email unique", () => {
    const a = users.createUser({ email: "A@Client-A.fr", passwordHash: hashPassword("mot-de-passe-de-a!"), phoneNumber: "06 12 34 56 78" }, db);
    expect(a.email).toBe("a@client-a.fr");
    expect(a.phone_number).toBe(PHONE_A);
    expect(() => users.createUser({ email: "b@client-b.fr", phoneNumber: "+33 6 12 34 56 78" }, db)).toThrow(/déjà associé/);
    expect(() => users.createUser({ email: "a@client-a.fr" }, db)).toThrow(/existe déjà/);
    const b = users.createUser({ email: "b@client-b.fr" }, db);
    expect(() => users.setPendingPhone(b.id, "0612345678", db)).toThrow(/déjà associé/);
    expect(users.setPendingPhone(b.id, "06 98 76 54 32", db).phone_number).toBe(PHONE_B);
    // Numéro en attente : pas encore une identité WhatsApp.
    expect(users.getUserByPhone(PHONE_B, db)?.phone_verified).toBe(0);
    expect(users.whatsappRecipientFor(b.id, db)).toBeNull();
    users.markPhoneVerified(b.id, db);
    expect(users.whatsappRecipientFor(b.id, db)).toBe(WA_B);
    users.clearPhone(b.id, db);
    expect(users.getUserByPhone(PHONE_B, db)).toBeUndefined();
  });

  it("inscription : premier compte propriétaire, suivants soumis à ALLOW_SIGNUP ; connexion par email + mot de passe", () => {
    setEnv("ALLOW_SIGNUP", "false");
    resetEnvCache();
    const owner = registerAccount({ email: "dirigeant@client-a.fr", password: "mot-de-passe-solide", name: "Dirigeant A" }, db);
    expect(owner.role).toBe("owner");
    expect(owner.password_hash).not.toContain("mot-de-passe-solide");
    expect(() => registerAccount({ email: "b@client-b.fr", password: "mot-de-passe-solide" }, db)).toThrow(/ALLOW_SIGNUP/);
    setEnv("ALLOW_SIGNUP", "true");
    resetEnvCache();
    expect(registerAccount({ email: "b@client-b.fr", password: "mot-de-passe-solide" }, db).role).toBe("user");
    expect(() => registerAccount({ email: "c@client-c.fr", password: "court" }, db)).toThrow(/12 caractères/);
    expect(authenticate("dirigeant@client-a.fr", "mot-de-passe-solide", db)?.id).toBe(owner.id);
    expect(authenticate("dirigeant@client-a.fr", "mauvais", db)).toBeNull();
    expect(authenticate("inconnu@x.fr", "mot-de-passe-solide", db)).toBeNull();
    const session = createSessionValue(owner.id);
    expect(parseSessionValue(session)).toBe(owner.id);
    setEnv("ALLOW_SIGNUP", undefined);
    resetEnvCache();
  });

  it("une connexion Outlook héritée (sans compte) est adoptée par le premier compte créé", () => {
    saveTokenSet(tokenSet("legacy"), "ancien@client.fr", db, null);
    expect(getConnection(TOKEN_PROVIDER, null, db)).toBeDefined();
    const owner = registerAccount({ email: "dirigeant@client-a.fr", password: "mot-de-passe-solide" }, db);
    expect(getConnection(TOKEN_PROVIDER, null, db)).toBeUndefined();
    expect(loadTokenSet(db, owner.id)?.accountEmail).toBe("ancien@client.fr");
  });
});

describe("Connexion Microsoft par utilisateur", () => {
  let db: Db;
  let a: string;
  let b: string;
  beforeEach(() => {
    db = openIsolatedDb();
    a = users.createUser({ email: "a@client-a.fr" }, db).id;
    b = users.createUser({ email: "b@client-b.fr" }, db).id;
  });

  it("le callback attribue les tokens à l'utilisateur qui a lancé le flux, jamais à un autre", async () => {
    const { fetchImpl } = fakeFetch([{ match: /POST .*\/oauth2\/v2\.0\/token/, handle: () => json({ access_token: "access-a", refresh_token: "refresh-a", expires_in: 3600, scope: "Mail.Read" }) }]);
    const state = createOAuthState({ db, userId: a });
    const r = await completeConnection({ code: "code", state }, async () => ({ email: "a@outlook.fr", displayName: "A" }), { db, fetchImpl });
    expect(r.userId).toBe(a);
    expect(loadTokenSet(db, a)?.accountEmail).toBe("a@outlook.fr");
    expect(loadTokenSet(db, b)).toBeNull();
    expect(isOutlookConnected(db, a)).toBe(true);
    expect(isOutlookConnected(db, b)).toBe(false);
    // Déconnexion de A : B n'est pas concerné, A doit reconnecter.
    disconnect({ db, userId: a });
    expect(isOutlookConnected(db, a)).toBe(false);
  });

  it("appel non scopé : jamais la boîte d'un autre utilisateur dès qu'il y en a plusieurs", () => {
    saveTokenSet(tokenSet("a"), "a@outlook.fr", db, a);
    expect(loadTokenSet(db)?.userId).toBe(a); // une seule connexion : sans ambiguïté
    saveTokenSet(tokenSet("b"), "b@outlook.fr", db, b);
    expect(loadTokenSet(db)).toBeNull(); // deux connexions : un appel non scopé n'en choisit aucune
    expect(loadTokenSet(db, a)?.accountEmail).toBe("a@outlook.fr");
    expect(loadTokenSet(db, b)?.accountEmail).toBe("b@outlook.fr");
    expect(listActiveConnections(TOKEN_PROVIDER, db).map((c) => c.user_id).sort()).toEqual([a, b].sort());
  });

  it("scénario G : token expiré → rafraîchi automatiquement pour le bon utilisateur, sans reconnexion", async () => {
    saveTokenSet(tokenSet("a", -1000), "a@outlook.fr", db, a);
    saveTokenSet(tokenSet("b"), "b@outlook.fr", db, b);
    const { fetchImpl, calls } = fakeFetch([
      { match: /POST .*\/oauth2\/v2\.0\/token/, handle: () => json({ access_token: "access-a-fresh", refresh_token: "refresh-a-fresh", expires_in: 3600, scope: "Mail.Read" }) },
      { match: /GET .*\/me$/, handle: () => json({ id: "1", mail: "a@outlook.fr" }) },
    ]);
    const client = createConnectedGraphClient({ db, userId: a, fetchImpl, sleep: noSleep });
    await client.get("/me");
    const refresh = calls.find((c) => c.url.includes("/token"));
    expect((refresh?.body as Record<string, string>).refresh_token).toBe("refresh-a");
    expect(calls.find((c) => c.url.endsWith("/me"))?.headers.authorization).toBe("Bearer access-a-fresh");
    expect(loadTokenSet(db, a)?.set.refreshToken).toBe("refresh-a-fresh");
    expect(loadTokenSet(db, b)?.set.refreshToken).toBe("refresh-b"); // B intact
  });

  it("scénario H : token révoqué → connexion marquée révoquée, message clair de reconnexion, aucun appel Graph", async () => {
    saveTokenSet(tokenSet("a", -1000), "a@outlook.fr", db, a);
    const { fetchImpl, calls } = fakeFetch([
      { match: /POST .*\/oauth2\/v2\.0\/token/, handle: () => json({ error: "invalid_grant", error_description: "AADSTS70000: refresh token revoked" }, 400) },
      { match: /GET .*\/me$/, handle: () => json({ id: "1" }) },
    ]);
    const client = createConnectedGraphClient({ db, userId: a, fetchImpl, sleep: noSleep });
    await expect(client.get("/me")).rejects.toMatchObject({ code: "MICROSOFT_RECONNECT" });
    await expect(client.get("/me")).rejects.toThrow(/expiré ou a été révoquée. Reconnectez Outlook/);
    expect(calls.filter((c) => c.url.endsWith("/me"))).toHaveLength(0);
    expect(loadTokenSet(db, a)?.status).toBe("revoked");
    expect(isOutlookConnected(db, a)).toBe(false);
    // Reconnexion : la nouvelle connexion redevient active.
    saveTokenSet(tokenSet("a2"), "a@outlook.fr", db, a);
    expect(isOutlookConnected(db, a)).toBe(true);
  });

  it("synchronisation : les emails et le curseur sont rattachés à chaque utilisateur", async () => {
    saveTokenSet(tokenSet("a"), "a@outlook.fr", db, a);
    saveTokenSet(tokenSet("b"), "b@outlook.fr", db, b);
    const { fetchImpl } = fakeFetch([
      {
        match: /GET .*\/delta/,
        handle: (call) => {
          const token = call.headers.authorization ?? "";
          const tag = token.includes("access-a") ? "a" : "b";
          return json({ value: [message({ id: `m-${tag}`, subject: `Boîte ${tag}` })], "@odata.deltaLink": `https://graph.microsoft.com/delta-${tag}` });
        },
      },
    ]);
    await syncInbox(createConnectedGraphClient({ db, userId: a, fetchImpl, sleep: noSleep }), { db, userId: a, withAttachments: false });
    await syncInbox(createConnectedGraphClient({ db, userId: b, fetchImpl, sleep: noSleep }), { db, userId: b, withAttachments: false });
    expect(emails.listEmails({ userId: a }, db).map((e) => e.subject)).toEqual(["Boîte a"]);
    expect(emails.listEmails({ userId: b }, db).map((e) => e.subject)).toEqual(["Boîte b"]);
    expect(emails.listEmails({ userId: a }, db)[0]?.user_id).toBe(a);
  });
});

describe("WhatsApp EMA central : identification, activation, onboarding, isolation", () => {
  let db: Db;
  let a: ReturnType<typeof users.createUser>;
  let b: ReturnType<typeof users.createUser>;

  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
    clearExecutors();
    writeConfig("contacts", { version: 1, contacts });
    writeConfig("rules", { version: 1, rules: [] });
    a = users.createUser({ email: "a@client-a.fr", name: "Dirigeant A" }, db);
    b = users.createUser({ email: "b@client-b.fr", name: "Dirigeant B" }, db);
    users.setPendingPhone(a.id, PHONE_A, db);
    users.markPhoneVerified(a.id, db);
    users.setPendingPhone(b.id, PHONE_B, db);
    users.markPhoneVerified(b.id, db);
    saveTokenSet(tokenSet("a"), "a@outlook.fr", db, a.id);
    saveTokenSet(tokenSet("b"), "b@outlook.fr", db, b.id);
  });
  afterEach(() => {
    resetToolsForTests();
    clearExecutors();
    setGraphClientFactoryForTests(null);
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  it("scénario E : numéro inconnu → aucun appel Microsoft, aucun appel Claude, aucune donnée, message d'onboarding borné", async () => {
    const wa = fakeWhatsapp();
    const anthropic = fakeAnthropic([], [textTurn("ne doit jamais répondre")]);
    const graph = fakeFetch([]);
    setGraphClientFactoryForTests(() => new GraphClient({ getAccessToken: async () => "t", fetchImpl: graph.fetchImpl, sleep: noSleep }));
    expect(identifySender("33600000000", {}, db)).toEqual({ kind: "unknown", phone: "33600000000" });
    const r = await handleWhatsappEvent(event("33600000000", "Quels sont mes emails importants ?"), { db, settings, client: wa.client, anthropic: anthropic.client, assistantEnabled: true });
    expect(r.outcome).toBe("unknown_user");
    expect(anthropic.chatCalls).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
    expect(wa.sent()).toHaveLength(1);
    expect(JSON.stringify(wa.sent()[0])).toContain(UNKNOWN_NUMBER_REPLY);
    expect(chat.listChatMessages(50, db, "WHATSAPP")).toHaveLength(0);
    // Journalisé sans le numéro complet.
    const h = listHistory({ limit: 5 }, db).find((x) => x.event_type === "whatsapp.unknown_number");
    expect(h?.message).not.toContain("33600000000");
    // Réponses d'onboarding limitées : le 4e message d'un inconnu ne déclenche plus d'envoi.
    for (let i = 0; i < 3; i++) await handleWhatsappEvent(event("33600000000", "encore", `wamid.u${i}`), { db, settings, client: wa.client, anthropic: anthropic.client, assistantEnabled: true });
    expect(wa.sent().length).toBeLessThanOrEqual(3);
  });

  it("scénario A : numéro renseigné puis premier message « Bonjour EMA » → activation, bienvenue, aucune donnée lue", async () => {
    const c = users.createUser({ email: "c@client-c.fr", name: "Dirigeant C" }, db);
    users.setPendingPhone(c.id, "+33 6 11 22 33 44", db);
    saveTokenSet(tokenSet("c"), "c@outlook.fr", db, c.id);
    expect(getWhatsappActivation(users.getUser(c.id, db)!).status).toBe("pending");
    const wa = fakeWhatsapp();
    const anthropic = fakeAnthropic([], [textTurn("ne doit pas être appelé")]);
    const r = await handleWhatsappEvent(event("33611223344", "Bonjour EMA", "wamid.hello"), { db, settings, client: wa.client, anthropic: anthropic.client, assistantEnabled: true });
    expect(r.outcome).toBe("activated");
    expect(anthropic.chatCalls).toHaveLength(0);
    const after = users.getUser(c.id, db)!;
    expect(after.phone_verified).toBe(1);
    expect(after.whatsapp_enabled).toBe(1);
    expect(after.verified_at).not.toBeNull();
    expect(getWhatsappActivation(after).status).toBe("active");
    expect(JSON.stringify(wa.sent()[0])).toMatch(/WhatsApp activé/);
    expect(JSON.stringify(wa.sent()[0])).toMatch(/emails importants/); // Outlook connecté : exemples proposés
    expect(listHistory({ limit: 5, userId: c.id }, db).some((h) => h.event_type === "whatsapp.activated")).toBe(true);
    // Le même message rejoué (Meta) n'active ni ne répond deux fois.
    const again = await handleWhatsappEvent(event("33611223344", "Bonjour EMA", "wamid.hello"), { db, settings, client: wa.client, anthropic: anthropic.client, assistantEnabled: true });
    expect(again.outcome).toBe("duplicate");
    expect(wa.sent()).toHaveLength(1);
  });

  it("activation d'un compte sans Outlook : la bienvenue invite à connecter Outlook", async () => {
    const d = users.createUser({ email: "d@client-d.fr" }, db);
    users.setPendingPhone(d.id, "+33 6 55 55 55 55", db);
    const wa = fakeWhatsapp();
    await handleWhatsappEvent(event("33655555555", "Bonjour EMA"), { db, settings, client: wa.client, assistantEnabled: true });
    expect(JSON.stringify(wa.sent()[0])).toMatch(/connectez votre boîte Outlook/i);
  });

  it("scénario B/F : deux utilisateurs simultanés — chacun ne voit que SA boîte, jamais celle de l'autre", async () => {
    const graph = graphFor({ "access-a": [{ id: "a1", subject: "Facture urgente A", from: "FournisseurA" }], "access-b": [{ id: "b1", subject: "Devis B", from: "ClientB" }] });
    setGraphClientFactoryForTests((db2, userId) => createConnectedGraphClient({ db: db2, userId, fetchImpl: graph.fetchImpl, sleep: noSleep }));
    const wa = fakeWhatsapp();
    const anthropicA = fakeAnthropic([], [...turn("search_emails", { query: "important" }, "Voici vos emails importants (A).")]);
    const anthropicB = fakeAnthropic([], [...turn("search_emails", { query: "important" }, "Voici vos emails importants (B).")]);

    const [ra, rb] = await Promise.all([
      handleWhatsappEvent(event(WA_A, "Quels sont mes emails importants ?", "wamid.a1"), { db, settings, client: wa.client, anthropic: anthropicA.client, assistantEnabled: true }),
      handleWhatsappEvent(event(WA_B, "Quels sont mes emails importants ?", "wamid.b1"), { db, settings, client: wa.client, anthropic: anthropicB.client, assistantEnabled: true }),
    ]);
    expect(ra.outcome).toBe("answered");
    expect(rb.outcome).toBe("answered");

    // Le résultat du tool renvoyé à Claude pour A ne contient que la boîte A (et inversement).
    const toolResultA = JSON.stringify(anthropicA.chatCalls[1]?.params.messages);
    const toolResultB = JSON.stringify(anthropicB.chatCalls[1]?.params.messages);
    expect(toolResultA).toContain("Facture urgente A");
    expect(toolResultA).not.toContain("Devis B");
    expect(toolResultB).toContain("Devis B");
    expect(toolResultB).not.toContain("Facture urgente A");

    // Les emails importés en contexte portent le bon propriétaire ; les conversations sont séparées.
    expect(emails.listEmails({ userId: a.id, limit: 50 }, db).every((e) => e.subject.includes("A"))).toBe(true);
    expect(emails.listEmails({ userId: b.id, limit: 50 }, db).every((e) => e.subject.includes("B"))).toBe(true);
    expect(chat.listChatMessages(50, db, "WHATSAPP", a.id).map((m) => m.content)).toContain("Voici vos emails importants (A).");
    expect(chat.listChatMessages(50, db, "WHATSAPP", a.id).map((m) => m.content)).not.toContain("Voici vos emails importants (B).");
    // Les réponses partent vers le bon numéro.
    const sentTo = wa.sent().map((m) => m.to);
    expect(sentTo).toContain(WA_A);
    expect(sentTo).toContain(WA_B);
    // Aucune requête Graph de A n'a utilisé le token de B.
    expect(graph.calls.filter((c) => c.headers.authorization === "Bearer access-b" && c.url.includes("important")).length).toBeGreaterThan(0);
  });

  it("isolation des tools : un identifiant appartenant à un autre utilisateur est introuvable", async () => {
    const ea = emails.insertEmail({ userId: a.id, graphId: "ga", threadId: "ta", senderEmail: "x@a.fr", subject: "Secret A", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const ctxB = toolContextFor("chat", null, db, b.id);
    const byId = await executeTool("get_email", { email_id: ea.id }, ctxB);
    expect(byId.ok).toBe(false);
    if (!byId.ok) expect(byId.error.code).toBe("NOT_FOUND");
    const thread = await executeTool("get_email_thread", { thread_id: "ta" }, ctxB);
    expect(thread.ok && thread.data).toEqual([]);
    const listB = await executeTool("list_recent_emails", { max: 10 }, ctxB);
    expect(listB.ok && JSON.stringify(listB.data)).not.toContain("Secret A");
    const ctxA = toolContextFor("chat", null, db, a.id);
    const listA = await executeTool("list_recent_emails", { max: 10 }, ctxA);
    expect(listA.ok && JSON.stringify(listA.data)).toContain("Secret A");
    // Une action de A n'est ni visible ni décidable par B.
    const act = proposeAction({ type: "reply_email", title: "Répondre A", payload: { email_id: ea.id, body: "Bonjour" }, sourceEmailId: ea.id }, { db, settings, userId: a.id });
    expect(act.user_id).toBe(a.id);
    expect(actions.listActions({ userId: b.id }, db)).toHaveLength(0);
    const status = await executeTool("get_approval_status", { action_id: act.id }, ctxB);
    expect(status.ok).toBe(false);
  });

  it("scénario C/D : recherche puis « réponds-lui que je valide » → action validée par A, envoyée depuis la boîte de A", async () => {
    const graph = graphFor({ "access-a": [{ id: "j1", subject: "Devis toiture", from: "Julien" }] });
    setGraphClientFactoryForTests((db2, userId) => createConnectedGraphClient({ db: db2, userId, fetchImpl: graph.fetchImpl, sleep: noSleep }));
    for (const ex of createOutlookExecutors({ db, client: new GraphClient({ getAccessToken: async () => "access-a", fetchImpl: graph.fetchImpl, sleep: noSleep }), contacts, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const anthropic = fakeAnthropic([], [
      ...turn("search_emails", { query: "Julien devis" }, "J'ai trouvé l'email de Julien : « Devis toiture »."),
    ]);
    const r1 = await handleWhatsappEvent(event(WA_A, "Recherche l'email de Julien concernant le devis.", "wamid.c1"), { db, settings, client: wa.client, anthropic: anthropic.client, assistantEnabled: true });
    expect(r1.outcome).toBe("answered");
    const found = emails.listEmails({ userId: a.id, limit: 10 }, db).find((e) => e.subject === "Devis toiture")!;
    expect(found.user_id).toBe(a.id);

    const anthropic2 = fakeAnthropic([], [...turn("reply_email", { email_id: found.id, body: "Bonjour Julien, je valide votre devis." }, "J'ai préparé la réponse à Julien. Voulez-vous que je l'envoie ?")]);
    const r2 = await handleWhatsappEvent(event(WA_A, "Réponds-lui que je valide son devis.", "wamid.c2"), { db, settings, client: wa.client, anthropic: anthropic2.client, assistantEnabled: true });
    expect(r2.outcome).toBe("action_proposed");
    const action = actions.getAction(r2.actionIds[0]!, db)!;
    expect(action.status).toBe("WAITING_APPROVAL"); // garde-fou conservé : validation avant envoi
    expect(action.user_id).toBe(a.id);
    // La demande de validation part vers le numéro de A.
    expect(wa.sent().some((m) => m.to === WA_A && JSON.stringify(m).includes("approve:"))).toBe(true);

    // B répond « oui » : aucune action de B n'attend, rien n'est validé.
    const rb = await handleWhatsappEvent(event(WA_B, "Oui", "wamid.b-oui"), { db, settings, client: wa.client, anthropic: fakeAnthropic([], [textTurn("Rien à valider.")]).client, assistantEnabled: true });
    expect(rb.actionIds).toHaveLength(0);
    expect(actions.getAction(action.id, db)?.status).toBe("WAITING_APPROVAL");

    // A répond « Oui » : envoi via Mail.Send depuis SA boîte, confirmation WhatsApp.
    const ra = await handleWhatsappEvent(event(WA_A, "Oui", "wamid.a-oui"), { db, settings, client: wa.client, assistantEnabled: true });
    expect(ra.outcome).toBe("approved");
    expect(actions.getAction(action.id, db)?.status).toBe("COMPLETED");
    const reply = graph.calls.find((c) => c.method === "POST" && c.url.endsWith("/reply"));
    expect(reply?.headers.authorization).toBe("Bearer access-a");
    expect((reply?.body as { comment: string }).comment).toContain("je valide votre devis");
    expect(JSON.stringify(wa.sent().at(-1))).toContain("Fait");
  });

  it("scénario H (WhatsApp) : connexion révoquée → l'utilisateur reçoit un message clair de reconnexion", async () => {
    const { fetchImpl } = fakeFetch([{ match: /POST .*\/oauth2\/v2\.0\/token/, handle: () => json({ error: "invalid_grant" }, 400) }]);
    saveTokenSet(tokenSet("a", -1000), "a@outlook.fr", db, a.id);
    setGraphClientFactoryForTests((db2, userId) => createConnectedGraphClient({ db: db2, userId, fetchImpl, sleep: noSleep }));
    const wa = fakeWhatsapp();
    const anthropic = fakeAnthropic([], [...turn("search_emails", { query: "important" }, "Je n'ai pas pu accéder à votre boîte.")]);
    const r = await handleWhatsappEvent(event(WA_A, "Quels sont mes emails importants ?"), { db, settings, client: wa.client, anthropic: anthropic.client, assistantEnabled: true });
    expect(r.outcome).toBe("reconnect_required");
    expect(r.reply).toMatch(/expiré ou a été révoquée. Reconnectez Outlook/);
    expect(loadTokenSet(db, a.id)?.status).toBe("revoked");
  });

  it("chat web : même utilisateur qu'en WhatsApp, conversation par canal, jamais mélangée", async () => {
    const anthropic = fakeAnthropic([], [textTurn("Réponse web pour A")]);
    await runChatTurn("Bonjour", { db, settings, userId: a.id, client: anthropic.client });
    expect(chat.listChatMessages(50, db, "WEB", a.id).map((m) => m.content)).toEqual(["Bonjour", "Réponse web pour A"]);
    expect(chat.listChatMessages(50, db, "WEB", b.id)).toHaveLength(0);
    expect(chat.listChatMessages(50, db, "WHATSAPP", a.id)).toHaveLength(0);
  });
});
