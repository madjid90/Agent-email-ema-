import { z } from "zod";
import { defineTool, actionRefSchema, assertOwned } from "../types";
import * as documentsRepo from "@/database/repositories/documents";
import * as actionsRepo from "@/database/repositories/actions";
import { EmaError } from "@/lib/errors";
import { prepareQuoteSignature } from "@/documents/sign";

/**
 * Seul tool de signature exposé à Claude : il crée une action CRITICAL via
 * l'Action Engine et ne signe JAMAIS lui-même. L'application de la signature et
 * du tampon reste interne (src/documents/sign.ts, exécuteur sign_document) et
 * n'existe pas sous forme de tool. Claude ne manipule que company_id.
 */
export const prepareSignedDocument = defineTool({
  name: "prepare_signed_document",
  description: "Propose de signer (bon pour accord, date, signature graphique et tampon de la société) un devis puis de le renvoyer au fournisseur dans le thread. Crée une action CRITICAL soumise à validation humaine ; ne signe rien immédiatement.",
  riskLevel: "CRITICAL",
  modes: ["analyze", "chat"],
  input: z.object({ document_id: z.string(), company_id: z.string().describe("Identifiant d'une société configurée") }),
  output: actionRefSchema.extend({ prepared: z.boolean(), reasons: z.array(z.string()), warnings: z.array(z.string()) }),
  handler: async (input, ctx) => {
    assertOwned(documentsRepo.getDocument(input.document_id, ctx.db), ctx, `Document ${input.document_id}`);
    if (!ctx.companies.some((c) => c.id === input.company_id)) throw new EmaError("VALIDATION", `Société inconnue : ${input.company_id}`);
    const r = prepareQuoteSignature(input.document_id, input.company_id, { db: ctx.db, settings: ctx.settings, companies: ctx.companies, userId: ctx.userId, actor: ctx.mode === "chat" ? "user" : "ema" });
    if (!r.actionId) return { action_id: "", status: "NOT_PROPOSED", requires_approval: true, prepared: false, reasons: r.readiness.reasons, warnings: r.readiness.warnings };
    const a = actionsRepo.getAction(r.actionId, ctx.db);
    return { action_id: r.actionId, status: a?.status ?? "WAITING_APPROVAL", requires_approval: true, prepared: true, reasons: [], warnings: r.readiness.warnings };
  },
});

export const signatureTools = [prepareSignedDocument];
