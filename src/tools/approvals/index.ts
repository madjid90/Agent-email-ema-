import { z } from "zod";
import { defineTool } from "../types";
import * as approvalsRepo from "@/database/repositories/approvals";
import * as actionsRepo from "@/database/repositories/actions";
import { EmaError } from "@/lib/errors";

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

export const approvalTools = [requestApproval, getApprovalStatus];
