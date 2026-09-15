import { z } from "zod";
import { defineTool, actionRefSchema } from "../types";
import { proposeAction } from "@/actions/engine";
import { EmaError } from "@/lib/errors";
import { formatAmount } from "@/lib/time";

/**
 * Tools paiements : EMA ne paie jamais. Ces tools préparent un email interne
 * et créent une action HIGH (validation obligatoire).
 */

function resolveRecipient(explicit: string | undefined, ctx: { settings: { company: { email: string } }; contacts: { id: string; email: string; role: string }[] }, keyword: RegExp): string {
  if (explicit) return explicit;
  const contact = ctx.contacts.find((c) => keyword.test(c.role));
  if (contact) return contact.email;
  if (ctx.settings.company.email) return ctx.settings.company.email;
  throw new EmaError("CONFIG", "Aucun destinataire configuré pour les demandes de paiement");
}

export const preparePaymentRequest = defineTool({
  name: "prepare_payment_request",
  description: "Prépare un email interne demandant de procéder à un règlement (facture non réglée, paiement attendu). Ne paie rien. Action HIGH à valider.",
  riskLevel: "HIGH",
  modes: ["analyze", "chat"],
  input: z.object({
    email_id: z.string().nullable().default(null),
    supplier: z.string(),
    amount: z.number().nullable().default(null),
    currency: z.string().default("EUR"),
    due_date: z.string().nullable().default(null),
    subject: z.string(),
    to: z.string().email().optional(),
  }),
  output: actionRefSchema.extend({ draft: z.string() }),
  handler: async (input, ctx) => {
    const to = resolveRecipient(input.to, ctx, /compta|paiement|finance/i);
    const amount = input.amount !== null ? ` (montant : ${formatAmount(input.amount, input.currency)})` : "";
    const due = input.due_date ? `, échéance le ${input.due_date}` : "";
    const body = `Bonjour,\n\nPeux-tu procéder au règlement de ${input.supplier} concernant « ${input.subject} »${amount}${due} ?\n\nMerci.\n\n${ctx.settings.agent.signatureText}`.trim();
    const a = proposeAction(
      {
        type: "payment_request",
        title: `Demande de règlement — ${input.supplier}${amount}`,
        payload: { email_id: input.email_id, to: [to], subject: `Règlement — ${input.supplier} — ${input.subject}`, body, supplier: input.supplier, amount: input.amount, currency: input.currency, due_date: input.due_date, project: null },
        sourceEmailId: input.email_id,
      },
      { db: ctx.db, settings: ctx.settings },
    );
    return { action_id: a.id, status: a.status, requires_approval: true, draft: body };
  },
});

export const prepareDepositRequest = defineTool({
  name: "prepare_deposit_request",
  description: "Prépare un email interne demandant le règlement d'un acompte pour un projet. Ne paie rien. Action HIGH à valider.",
  riskLevel: "HIGH",
  modes: ["analyze", "chat"],
  input: z.object({
    email_id: z.string().nullable().default(null),
    supplier: z.string(),
    project: z.string(),
    amount: z.number().nullable().default(null),
    currency: z.string().default("EUR"),
    to: z.string().email().optional(),
  }),
  output: actionRefSchema.extend({ draft: z.string() }),
  handler: async (input, ctx) => {
    const to = resolveRecipient(input.to, ctx, /compta|paiement|finance/i);
    const amount = input.amount !== null ? ` (montant : ${formatAmount(input.amount, input.currency)})` : "";
    const body = `Bonjour,\n\nPeux-tu procéder au règlement de l'acompte concernant le projet ${input.project} auprès de ${input.supplier}${amount} ?\n\nMerci.\n\n${ctx.settings.agent.signatureText}`.trim();
    const a = proposeAction(
      {
        type: "deposit_request",
        title: `Demande d'acompte — ${input.project}${amount}`,
        payload: { email_id: input.email_id, to: [to], subject: `Acompte — ${input.project}`, body, supplier: input.supplier, amount: input.amount, currency: input.currency, due_date: null, project: input.project },
        sourceEmailId: input.email_id,
      },
      { db: ctx.db, settings: ctx.settings },
    );
    return { action_id: a.id, status: a.status, requires_approval: true, draft: body };
  },
});

export const paymentTools = [preparePaymentRequest, prepareDepositRequest];
