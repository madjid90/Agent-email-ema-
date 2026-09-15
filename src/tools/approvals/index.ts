import { z } from "zod";
import { defineTool } from "../types";
import * as approvalsRepo from "@/database/repositories/approvals";
import * as actionsRepo from "@/database/repositories/actions";
import { EmaError } from "@/lib/errors";
import { editActionPayload } from "@/actions/engine";
import { parseJson } from "@/database/types";

/**
 * La demande de validation est créée automatiquement par l'Action Engine
 * (proposeAction). `request_approval` permet de relancer l'envoi WhatsApp
 * (implémentation phase 3) ; `get_approval_status` est en lecture seule.
 */
export const requestApproval = defineTool({
  name: "request_approval",
  description: "(Re)demande la validation humaine d'une action en attente.",
  riskLevel: "LOW",
  modes: ["internal"],
  input: z.object({ action_id: z.string() }),
  output: z.object({ approval_id: z.string(), status: z.string() }),
  handler: async (input, ctx) => {
    const action = actionsRepo.getAction(input.action_id, ctx.db);
    if (!action) throw new EmaError("NOT_FOUND", `Action ${input.action_id} introuvable`);
    const pending = approvalsRepo.getPendingApprovalForAction(action.id, ctx.db);
    if (!pending) throw new EmaError("CONFLICT", "Aucune validation en attente pour cette action");
    return { approval_id: pending.id, status: pending.status };
  },
});

export const getApprovalStatus = defineTool({
  name: "get_approval_status",
  description: "Donne le statut d'une demande de validation.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ approval_id: z.string() }),
  output: z.object({ status: z.string(), decided_at: z.string().nullable(), comment: z.string().nullable() }),
  handler: async (input, ctx) => {
    const a = approvalsRepo.getApproval(input.approval_id, ctx.db);
    if (!a) throw new EmaError("NOT_FOUND", `Validation ${input.approval_id} introuvable`);
    return { status: a.status, decided_at: a.decided_at, comment: a.comment };
  },
});

/**
 * Modification d'un brouillon en attente (« ajoute que ce sera à 10h »).
 * Seuls le texte et l'objet sont modifiables : les destinataires restent ceux
 * résolus de façon déterministe (règles, contacts) et ne sont jamais réécrits
 * par le modèle. L'action reste en attente de validation.
 */
export const updateDraft = defineTool({
  name: "update_draft",
  description: "Modifie le texte (et éventuellement l'objet) d'un brouillon en attente de validation. Ne change ni le destinataire, ni le niveau de risque, ni le statut : l'action reste soumise à validation.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ action_id: z.string(), body: z.string().min(1), subject: z.string().optional() }),
  output: z.object({ action_id: z.string(), status: z.string(), requires_approval: z.boolean(), body: z.string(), subject: z.string().nullable(), to: z.array(z.string()) }),
  handler: async (input, ctx) => {
    const action = actionsRepo.getAction(input.action_id, ctx.db);
    if (!action) throw new EmaError("NOT_FOUND", `Action ${input.action_id} introuvable`);
    if (action.type === "sign_document") throw new EmaError("VALIDATION", "Le contenu d'une demande de signature ne se modifie pas : refusez-la et préparez-en une nouvelle");
    const patch: Record<string, unknown> = { body: input.body };
    if (input.subject) patch.subject = input.subject;
    const updated = editActionPayload(action.id, patch, "user", { db: ctx.db, settings: ctx.settings });
    const payload = parseJson<Record<string, unknown>>(updated.payload, {});
    return {
      action_id: updated.id,
      status: updated.status,
      requires_approval: updated.requires_approval === 1,
      body: typeof payload.body === "string" ? payload.body : input.body,
      subject: typeof payload.subject === "string" ? payload.subject : null,
      to: Array.isArray(payload.to) ? (payload.to as string[]) : [],
    };
  },
});

export const approvalTools = [requestApproval, getApprovalStatus, updateDraft];
