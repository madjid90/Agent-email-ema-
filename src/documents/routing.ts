import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import { logHistory } from "@/database/repositories/history";
import type { DocumentRow, EmailRow } from "@/database/types";
import type { Contact, Rule, Settings } from "@/lib/config";
import { formatAmount } from "@/lib/time";
import { proposeAction } from "@/actions/engine";
import type { EmailAnalysis } from "@/agent/schemas";
import { evaluateRules, type RuleOutcome } from "@/agent/rules";
import type { DocumentExtraction } from "./types";

/**
 * Routage déterministe des actions administratives financières.
 * Le destinataire vient TOUJOURS de config/rules.json ou d'un contact interne
 * configuré, jamais du modèle. Sans destinataire fiable : aucune action,
 * vérification humaine. Aucune action bancaire n'existe.
 */
export interface FinancialContext {
  email: EmailRow;
  analysis: EmailAnalysis;
  rules: Rule[];
  contacts: Contact[];
  settings: Settings;
  documents: { row: DocumentRow; extraction: DocumentExtraction | null }[];
}

export interface FinancialOutcome {
  actionIds: string[];
  blockedReasons: string[];
  rules: RuleOutcome | null;
}

const PAYMENT_ROLE = /compta|comptabilit|paiement|finance|tr[ée]sorerie|r[èe]glement/i;

/** Contact interne pour les demandes de règlement : règle `forward` de la catégorie, sinon contact au rôle comptable. */
export function resolvePaymentRecipient(outcome: RuleOutcome, contacts: Contact[]): string | null {
  if (outcome.forwardTo) return outcome.forwardTo;
  const contact = contacts.find((c) => c.internal && PAYMENT_ROLE.test(c.role));
  return contact?.email ?? null;
}

function primaryInvoice(ctx: FinancialContext): { row: DocumentRow; extraction: DocumentExtraction } | null {
  const withData = ctx.documents.filter((d): d is { row: DocumentRow; extraction: DocumentExtraction } => d.extraction !== null);
  return withData.find((d) => d.extraction.document_type === "INVOICE" || d.extraction.document_type === "CREDIT_NOTE") ?? withData[0] ?? null;
}

export function proposeFinancialActions(ctx: FinancialContext, db: Db = getDb()): FinancialOutcome {
  const { email, analysis } = ctx;
  const out: FinancialOutcome = { actionIds: [], blockedReasons: [], rules: null };
  const category = analysis.category;
  const relevant = category === "INVOICE" || category === "PAYMENT_REQUEST" || category === "DEPOSIT_REQUEST" || category === "SUPPLIER_FOLLOWUP" || ctx.documents.some((d) => d.extraction && (d.extraction.document_type === "INVOICE" || d.extraction.document_type === "CREDIT_NOTE"));
  if (!relevant) return out;

  const doc = primaryInvoice(ctx);
  const x = doc?.extraction ?? null;
  const supplier = x?.supplier_name ?? analysis.sender.organization ?? analysis.company_name ?? analysis.sender.name ?? null;
  const amount = x?.amount_incl_tax ?? analysis.amount;
  const currency = x?.currency ?? analysis.currency ?? "EUR";
  const companyId = x?.company_id ?? analysis.company_id;
  const invoiceNumber = x?.invoice_number ?? null;
  const dueDate = x?.due_date ?? analysis.due_date;

  const outcome = evaluateRules(ctx.rules, { category, supplier, senderEmail: email.sender_email, subject: email.subject, companyId, amount });
  out.rules = outcome;

  const block = (reason: string) => {
    out.blockedReasons.push(reason);
    logHistory({ eventType: "action.blocked", message: `Aucune action automatique : ${reason}`, actor: "ema", emailId: email.id, documentId: doc?.row.id ?? null }, db);
  };

  if (analysis.injection_suspected || ctx.documents.some((d) => d.extraction?.injection_suspected)) return (block("tentative d'instruction détectée dans l'email ou le document"), out);
  if (ctx.documents.some((d) => d.extraction?.bank_details_change_suspected || d.extraction?.document_type === "BANK_DETAILS")) return (block("changement de coordonnées bancaires détecté — vérification humaine requise"), out);
  if (outcome.ignore) return (block("règle « ignorer » appliquée"), out);
  if (ctx.documents.some((d) => d.row.possible_duplicate === 1)) return (block("doublon potentiel de facture — vérification humaine requise"), out);
  // Déjà proposé (réanalyse) : une seule action active par email.
  const existing = actionsRepo.listActionsForEmail(email.id, db).find((a) => (a.status === "WAITING_APPROVAL" || a.status === "PROPOSED") && a.type !== "reply_email");
  if (existing) return { actionIds: [existing.id], blockedReasons: [], rules: outcome };

  const details = [supplier ? `Fournisseur : ${supplier}` : null, invoiceNumber ? `Facture : ${invoiceNumber}` : null, amount !== null ? `Montant : ${formatAmount(amount, currency)} TTC` : null, dueDate ? `Échéance : ${dueDate}` : null].filter((v): v is string => v !== null);

  if (category === "PAYMENT_REQUEST" || category === "DEPOSIT_REQUEST") {
    const to = resolvePaymentRecipient(outcome, ctx.contacts);
    if (!to) return (block("aucun contact interne configuré pour les demandes de règlement (règle ou contact au rôle comptabilité)"), out);
    const isDeposit = category === "DEPOSIT_REQUEST";
    const depositAmount = x?.deposit_amount ?? (isDeposit ? analysis.amount : null);
    const label = isDeposit ? "l'acompte" : "la facture";
    const ref = invoiceNumber ? ` ${invoiceNumber}` : "";
    const amt = (isDeposit ? depositAmount : amount) !== null ? ` d'un montant de ${formatAmount((isDeposit ? depositAmount : amount) as number, currency)}${isDeposit ? "" : " TTC"}` : "";
    const pct = isDeposit && x?.deposit_percent !== null && x?.deposit_percent !== undefined ? ` (${x.deposit_percent} %${x.total_amount !== null ? ` de ${formatAmount(x.total_amount, currency)}` : ""})` : "";
    const body = [
      "Bonjour,",
      "",
      `Peux-tu procéder au règlement de ${label} ${supplier ?? "du fournisseur"}${ref}${amt}${pct} ?`,
      dueDate ? `\nÉchéance : ${dueDate}.` : "",
      "",
      "Merci.",
      "",
      ctx.settings.agent.signatureText,
    ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const subject = `${isDeposit ? "Demande d'acompte" : "Demande de règlement"} — ${supplier ?? "Fournisseur"}${ref ? ` — facture${ref}` : ""}`;
    const action = proposeAction(
      {
        type: isDeposit ? "deposit_request" : "payment_request",
        title: `${subject}${amount !== null || depositAmount !== null ? ` (${formatAmount((isDeposit ? depositAmount : amount) as number, currency)})` : ""}`,
        payload: { email_id: email.id, to: [to], subject, body, supplier, amount: isDeposit ? depositAmount : amount, currency, due_date: dueDate, project: isDeposit ? email.subject : null },
        sourceEmailId: email.id,
        companyId,
        documentId: doc?.row.id ?? null,
        requiresApproval: true,
        actor: "ema",
      },
      { db, settings: ctx.settings },
    );
    logHistory({ eventType: "rule.applied", message: `Demande interne de règlement préparée pour ${to}${outcome.forwardRule ? ` (règle ${outcome.forwardRule.id})` : " (contact comptabilité)"} — aucun paiement bancaire`, actor: "ema", actionId: action.id, emailId: email.id, documentId: doc?.row.id ?? null, details }, db);
    out.actionIds.push(action.id);
    return out;
  }

  // Facture (ou relance fournisseur avec facture) : transfert selon les règles.
  if (!outcome.forwardTo) return (block("aucune règle de routage ne désigne un destinataire pour cette facture"), out);
  const comment = ["Bonjour,", "", `Pouvez-vous prendre en charge cette facture${supplier ? ` ${supplier}` : ""}${invoiceNumber ? ` n° ${invoiceNumber}` : ""}${amount !== null ? ` (${formatAmount(amount, currency)} TTC)` : ""}${dueDate ? `, échéance ${dueDate}` : ""} ?`, "", "Merci.", "", ctx.settings.agent.signatureText].join("\n").trim();
  const action = proposeAction(
    {
      type: "forward_email",
      title: `Transférer la facture${supplier ? ` ${supplier}` : ""}${invoiceNumber ? ` n° ${invoiceNumber}` : ""} à ${outcome.forwardTo}`,
      payload: { email_id: email.id, to: [outcome.forwardTo], comment },
      sourceEmailId: email.id,
      companyId,
      documentId: doc?.row.id ?? null,
      requiresApproval: true,
      actor: "ema",
    },
    { db, settings: ctx.settings },
  );
  logHistory({ eventType: "rule.applied", message: `Règle ${outcome.forwardRule?.id ?? "?"} : transfert proposé à ${outcome.forwardTo}`, actor: "ema", actionId: action.id, emailId: email.id, documentId: doc?.row.id ?? null, details }, db);
  out.actionIds.push(action.id);
  return out;
}
