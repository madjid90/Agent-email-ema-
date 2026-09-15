import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as emailsRepo from "@/database/repositories/emails";
import * as documentsRepo from "@/database/repositories/documents";
import { getCompanies, getContacts, getRules, getSettings, type Company, type Rule, type Settings } from "@/lib/config";
import { wrapUntrusted, looksLikeInjection } from "@/security/untrusted";
import { EmaError } from "@/lib/errors";
import type { EmailRow } from "@/database/types";

/**
 * Construction du contexte borné envoyé à Claude (CLAUDE.md §5.11) :
 * email courant + thread + historique pertinent + règles pertinentes + sociétés.
 * Jamais toute la mailbox. Tout contenu externe est encapsulé.
 */
export interface EmailContext {
  email: EmailRow;
  thread: EmailRow[];
  documents: { id: string; name: string; mime_type: string; category: string }[];
  previousActions: { id: string; type: string; title: string; status: string; created_at: string }[];
  applicableRules: Rule[];
  companies: Pick<Company, "id" | "name" | "aliases">[];
  settings: Settings;
  injectionSuspected: boolean;
}

const MAX_THREAD_MESSAGES = 10;
const MAX_PREVIOUS_ACTIONS = 5;

export function buildEmailContext(emailId: string, db: Db = getDb()): EmailContext {
  const email = emailsRepo.getEmail(emailId, db);
  if (!email) throw new EmaError("NOT_FOUND", `Email ${emailId} introuvable`);
  const thread = email.thread_id ? emailsRepo.listThread(email.thread_id, db).slice(-MAX_THREAD_MESSAGES) : [email];
  const documents = documentsRepo.listDocuments({ emailId: email.id }, db).map((d) => ({ id: d.id, name: d.name, mime_type: d.mime_type, category: d.category }));
  const previousActions = db
    .prepare(
      `SELECT a.id, a.type, a.title, a.status, a.created_at FROM actions a
       JOIN emails e ON e.id = a.source_email_id
       WHERE (e.thread_id = @thread OR e.sender_email = @sender) AND a.source_email_id != @id
       ORDER BY a.created_at DESC LIMIT @limit`,
    )
    .all({ thread: email.thread_id ?? "", sender: email.sender_email ?? "", id: email.id, limit: MAX_PREVIOUS_ACTIONS }) as EmailContext["previousActions"];
  const rules = getRules().filter((r) => r.enabled);
  const applicableRules = rules.filter((r) => ruleMayApply(r, email));
  const companies = getCompanies().map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
  const text = `${email.subject}\n${email.body_text ?? email.body_preview}`;
  return { email, thread, documents, previousActions, applicableRules, companies, settings: getSettings(), injectionSuspected: looksLikeInjection(text) };
}

/** Pré-filtre grossier des règles (la catégorie n'est connue qu'après analyse). */
function ruleMayApply(rule: Rule, email: EmailRow): boolean {
  const w = rule.when;
  const subject = email.subject.toLowerCase();
  const sender = (email.sender_email ?? "").toLowerCase();
  if (w.senderEmail && sender !== w.senderEmail.toLowerCase()) return false;
  if (w.senderDomain && !sender.endsWith(`@${w.senderDomain.toLowerCase()}`)) return false;
  if (w.subjectContains && !subject.includes(w.subjectContains.toLowerCase())) return false;
  return true;
}

/** Rendu texte du contexte pour le message utilisateur envoyé à Claude. */
export function renderEmailContext(ctx: EmailContext): string {
  const parts: string[] = [];
  parts.push("## Sociétés connues\n" + (ctx.companies.length ? ctx.companies.map((c) => `- ${c.id} : ${c.name}${c.aliases.length ? ` (alias : ${c.aliases.join(", ")})` : ""}`).join("\n") : "(aucune)"));
  parts.push(
    "## Règles applicables\n" +
      (ctx.applicableRules.length
        ? ctx.applicableRules.map((r) => `- [${r.id}] ${r.name} → ${describeEffect(r)}`).join("\n")
        : "(aucune règle spécifique ; appliquer les règles générales)"),
  );
  parts.push("## Contacts internes\n" + getContacts().map((c) => `- ${c.name} <${c.email}> : ${c.role}`).join("\n"));
  if (ctx.previousActions.length) {
    parts.push("## Actions précédentes avec cet expéditeur / ce thread\n" + ctx.previousActions.map((a) => `- ${a.created_at} · ${a.type} · ${a.title} · ${a.status}`).join("\n"));
  }
  if (ctx.documents.length) {
    parts.push("## Pièces jointes archivées\n" + ctx.documents.map((d) => `- ${d.id} : ${d.name} (${d.mime_type})`).join("\n"));
  }
  parts.push(`## Signature à utiliser\n${ctx.settings.agent.signatureText || "(aucune)"}`);
  if (ctx.thread.length > 1) {
    const previous = ctx.thread.filter((e) => e.id !== ctx.email.id);
    parts.push(
      "## Thread (du plus ancien au plus récent)\n" +
        previous.map((e) => wrapUntrusted(`De : ${e.sender_name ?? ""} <${e.sender_email ?? ""}>\nDate : ${e.received_at}\nObjet : ${e.subject}\n\n${e.body_text ?? e.body_preview}`, { kind: "thread", id: e.id }, 6000)).join("\n\n"),
    );
  }
  parts.push(
    "## Email à analyser\n" +
      wrapUntrusted(
        `De : ${ctx.email.sender_name ?? ""} <${ctx.email.sender_email ?? ""}>\nÀ : ${ctx.email.to_recipients}\nDate : ${ctx.email.received_at}\nObjet : ${ctx.email.subject}\nPièces jointes : ${ctx.email.has_attachments ? "oui" : "non"}\n\n${ctx.email.body_text ?? ctx.email.body_preview}`,
        { kind: "email", id: ctx.email.id },
      ),
  );
  return parts.join("\n\n");
}

function describeEffect(r: Rule): string {
  switch (r.then.action) {
    case "forward":
      return `transférer à ${r.then.to}${r.then.requiresApproval ? " (après validation)" : ""}`;
    case "reply_template":
      return `répondre avec le modèle « ${r.then.template} »`;
    case "require_approval":
      return "validation obligatoire";
    case "notify":
      return "notifier l'utilisateur";
    case "ignore":
      return "ignorer";
  }
}

export function toolContextFor(mode: "analyze" | "chat" | "followup" | "internal", currentEmailId?: string | null, db: Db = getDb()) {
  return { db, settings: getSettings(), rules: getRules(), companies: getCompanies(), contacts: getContacts(), mode, currentEmailId: currentEmailId ?? null };
}
