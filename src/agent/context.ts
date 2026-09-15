import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as emailsRepo from "@/database/repositories/emails";
import * as documentsRepo from "@/database/repositories/documents";
import { listRecentAnalysesFromSender } from "@/database/repositories/analyses";
import { getCompanies, getContacts, getRules, getSettings, type Company, type Contact, type Rule, type Settings } from "@/lib/config";
import { wrapUntrusted, looksLikeInjection } from "@/security/untrusted";
import { EmaError } from "@/lib/errors";
import type { EmailRow } from "@/database/types";
import { parseJson } from "@/database/types";
import { candidateRules, describeRule } from "./rules";

/**
 * Context Engine : contexte BORNÉ envoyé à Claude (CLAUDE.md §5.11).
 * Contenu de confiance (règles, sociétés, contacts, paramètres) d'un côté ;
 * contenu non fiable (email, thread, pièces jointes) encapsulé de l'autre.
 * Jamais toute la mailbox, jamais de secret, jamais d'image de signature.
 */
export const CONTEXT_LIMITS = {
  emailBodyChars: 12_000,
  threadMessageChars: 2_500,
  threadTotalChars: 12_000,
  attachmentTextChars: 3_000,
  maxCompanies: 12,
  maxContacts: 20,
  maxRules: 20,
  maxPreviousAnalyses: 3,
} as const;

export interface AttachmentContext {
  document_id: string;
  name: string;
  mime_type: string;
  size: number;
  text_excerpt: string | null;
}

export interface EmailContext {
  email: EmailRow;
  thread: EmailRow[];
  attachments: AttachmentContext[];
  previousAnalyses: { subject: string; received_at: string; category: string; summary: string }[];
  rules: Rule[];
  companies: Company[];
  contacts: Contact[];
  settings: Settings;
  injectionSuspected: boolean;
}

export interface ContextDeps {
  db?: Db;
  settings?: Settings;
  rules?: Rule[];
  companies?: Company[];
  contacts?: Contact[];
}

export function buildEmailContext(emailId: string, deps: ContextDeps = {}): EmailContext {
  const db = deps.db ?? getDb();
  const settings = deps.settings ?? getSettings();
  const email = emailsRepo.getEmail(emailId, db);
  if (!email) throw new EmaError("NOT_FOUND", `Email ${emailId} introuvable`);

  const maxThread = settings.analysis.maxThreadMessages;
  const thread = email.thread_id ? emailsRepo.listThread(email.thread_id, db).filter((e) => e.id !== email.id).slice(-maxThread) : [];

  const attachments: AttachmentContext[] = documentsRepo.listDocuments({ emailId: email.id }, db).map((d) => ({
    document_id: d.id,
    name: d.name,
    mime_type: d.mime_type,
    size: d.size,
    text_excerpt: d.extracted_text ? d.extracted_text.slice(0, CONTEXT_LIMITS.attachmentTextChars) : null,
  }));

  const previousAnalyses = email.sender_email
    ? listRecentAnalysesFromSender(email.sender_email, email.id, CONTEXT_LIMITS.maxPreviousAnalyses, db).map((a) => ({ subject: a.subject, received_at: a.received_at, category: a.category, summary: a.summary }))
    : [];

  const allCompanies = deps.companies ?? getCompanies();
  const haystack = `${email.subject}\n${email.body_text ?? email.body_preview}\n${email.sender_email ?? ""}\n${email.to_recipients}`.toLowerCase();
  const mentioned = allCompanies.filter((c) => [c.name, ...c.aliases].some((n) => n && haystack.includes(n.toLowerCase())));
  const companies = [...mentioned, ...allCompanies.filter((c) => !mentioned.includes(c))].slice(0, CONTEXT_LIMITS.maxCompanies);

  const contacts = (deps.contacts ?? getContacts()).slice(0, CONTEXT_LIMITS.maxContacts);
  const rules = candidateRules(deps.rules ?? getRules(), email).slice(0, CONTEXT_LIMITS.maxRules);

  const text = `${email.subject}\n${email.body_text ?? email.body_preview}`;
  return { email, thread, attachments, previousAnalyses, rules, companies, contacts, settings, injectionSuspected: looksLikeInjection(text) };
}

/** Partie de confiance du message utilisateur : données de l'application, pas de contenu externe. */
export function renderTrustedContext(ctx: EmailContext): string {
  const parts: string[] = [];
  parts.push(
    "## Sociétés du client (company_id : nom)\n" +
      (ctx.companies.length ? ctx.companies.map((c) => `- ${c.id} : ${c.name}${c.aliases.length ? ` (alias : ${c.aliases.join(", ")})` : ""}`).join("\n") : "(aucune société configurée)"),
  );
  parts.push("## Contacts internes\n" + (ctx.contacts.length ? ctx.contacts.map((c) => `- ${c.name} <${c.email}> : ${c.role}`).join("\n") : "(aucun)"));
  parts.push("## Règles métier applicables\n" + (ctx.rules.length ? ctx.rules.map((r) => `- [${r.id}] ${describeRule(r)}`).join("\n") : "(aucune règle spécifique)"));
  if (ctx.previousAnalyses.length) {
    parts.push("## Emails précédents du même expéditeur (analyses EMA)\n" + ctx.previousAnalyses.map((a) => `- ${a.received_at.slice(0, 10)} · ${a.category} · ${a.subject} : ${a.summary}`).join("\n"));
  }
  parts.push(`## Paramètres\n- Utilisateur : ${ctx.settings.company.userName || "(non renseigné)"} — ${ctx.settings.company.name || ""}\n- Adresse de la boîte : ${ctx.settings.company.email || "(inconnue)"}\n- Ton : ${ctx.settings.agent.tone}\n- Signature à utiliser :\n${ctx.settings.agent.signatureText || "(aucune)"}`);
  return parts.join("\n\n");
}

/** Partie non fiable : email courant, thread, pièces jointes, encapsulés. */
export function renderUntrustedContext(ctx: EmailContext): string {
  const parts: string[] = [];
  if (ctx.thread.length) {
    let budget = CONTEXT_LIMITS.threadTotalChars;
    const blocks: string[] = [];
    for (const m of [...ctx.thread].reverse()) {
      if (budget <= 0) break;
      const body = (m.body_text ?? m.body_preview).slice(0, Math.min(CONTEXT_LIMITS.threadMessageChars, budget));
      budget -= body.length;
      blocks.unshift(
        wrapUntrusted(`De : ${m.sender_name ?? ""} <${m.sender_email ?? ""}> (${m.direction === "outbound" ? "nous" : "tiers"})\nDate : ${m.received_at}\nObjet : ${m.subject}\n\n${body}`, { kind: "thread", id: m.id }, CONTEXT_LIMITS.threadMessageChars + 400),
      );
    }
    parts.push(`## Thread (${ctx.thread.length} message(s) précédent(s), du plus ancien au plus récent)\n${blocks.join("\n\n")}`);
  }
  const e = ctx.email;
  parts.push(
    "## Email à analyser\n" +
      wrapUntrusted(
        `De : ${e.sender_name ?? ""} <${e.sender_email ?? ""}>\nÀ : ${parseJson<string[]>(e.to_recipients, []).join(", ")}\nCc : ${parseJson<string[]>(e.cc_recipients, []).join(", ") || "—"}\nDate : ${e.received_at}\nObjet : ${e.subject}\n\n${e.body_text ?? e.body_preview}`,
        { kind: "email", id: e.id },
        CONTEXT_LIMITS.emailBodyChars + 600,
      ),
  );
  if (ctx.attachments.length) {
    parts.push(
      "## Pièces jointes\n" +
        ctx.attachments
          .map((a) => {
            const meta = `- ${a.document_id} : ${a.name} (${a.mime_type}, ${Math.round(a.size / 1024)} Ko)`;
            return a.text_excerpt ? `${meta}\n${wrapUntrusted(a.text_excerpt, { kind: "attachment", id: a.document_id, label: a.name }, CONTEXT_LIMITS.attachmentTextChars + 200)}` : `${meta} — contenu non extrait`;
          })
          .join("\n"),
    );
  } else if (e.has_attachments === 1) {
    parts.push("## Pièces jointes\n(présentes mais non archivées : ne pas en déduire le contenu)");
  }
  return parts.join("\n\n");
}

export function toolContextFor(mode: "analyze" | "chat" | "followup" | "internal", currentEmailId?: string | null, db: Db = getDb()) {
  return { db, settings: getSettings(), rules: getRules(), companies: getCompanies(), contacts: getContacts(), mode, currentEmailId: currentEmailId ?? null };
}
