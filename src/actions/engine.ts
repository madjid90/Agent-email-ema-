import { z } from "zod";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import * as approvalsRepo from "@/database/repositories/approvals";
import { logHistory } from "@/database/repositories/history";
import type { ActionRow, ActionStatus } from "@/database/types";
import { parseJson } from "@/database/types";
import { EmaError } from "@/lib/errors";
import { nowIso, addHoursSafe } from "./time";
import { getSettings, type Settings } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { ACTION_PAYLOAD_SCHEMAS, ALLOWED_TRANSITIONS, actionTypeSchema, type ActionExecutor, type ActionType, type ProposeActionInput } from "./types";
import { requiresApproval, resolveRiskLevel } from "./policy";

const log = createLogger("actions");

/* Registre d'exécuteurs -------------------------------------------------- */

const executors = new Map<ActionType, ActionExecutor>();

export function registerExecutor(executor: ActionExecutor): void {
  executors.set(executor.type, executor);
}

export function getExecutor(type: ActionType): ActionExecutor | undefined {
  return executors.get(type);
}

export function clearExecutors(): void {
  executors.clear();
}

/* Options (injection pour les tests) ------------------------------------ */

export interface EngineOptions {
  db?: Db;
  settings?: Settings;
}

function resolve(opts: EngineOptions): { db: Db; settings: Settings } {
  return { db: opts.db ?? getDb(), settings: opts.settings ?? getSettings() };
}

/* Proposition ------------------------------------------------------------ */

export function proposeAction<T extends ActionType>(input: ProposeActionInput<T>, opts: EngineOptions = {}): ActionRow {
  const { db, settings } = resolve(opts);
  const type = actionTypeSchema.parse(input.type);
  const schema: z.ZodTypeAny = ACTION_PAYLOAD_SCHEMAS[type];
  const payload = schema.safeParse(input.payload);
  if (!payload.success) {
    throw new EmaError("VALIDATION", `Payload invalide pour l'action ${type}`, {
      details: payload.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const risk = resolveRiskLevel(type, input.riskLevel);
  const needsApproval = requiresApproval(type, risk, input.requiresApproval, settings);
  const initialStatus: ActionStatus = needsApproval ? "WAITING_APPROVAL" : "APPROVED";

  const row = actionsRepo.insertAction(
    {
      type,
      title: input.title,
      sourceEmailId: input.sourceEmailId ?? null,
      companyId: input.companyId ?? null,
      documentId: input.documentId ?? null,
      payload: payload.data,
      status: "PROPOSED",
      riskLevel: risk,
      requiresApproval: needsApproval,
    },
    db,
  );
  logHistory({ eventType: "action.proposed", message: `Action proposée : ${input.title}`, actor: input.actor ?? "ema", actionId: row.id, emailId: row.source_email_id, details: { type, risk } }, db);

  const extra = initialStatus === "APPROVED" ? { approved_at: nowIso() } : {};
  actionsRepo.transitionAction(row.id, "PROPOSED", initialStatus, extra, db);
  if (initialStatus === "WAITING_APPROVAL") {
    approvalsRepo.insertApproval(
      {
        actionId: row.id,
        channel: settings.approvals.channel,
        summary: input.title,
        proposedReply: extractProposedReply(type, payload.data),
        expiresAt: addHoursSafe(nowIso(), settings.approvals.expireAfterHours),
      },
      db,
    );
    logHistory({ eventType: "approval.requested", message: `Validation demandée (${settings.approvals.channel})`, actionId: row.id, emailId: row.source_email_id }, db);
  } else {
    logHistory({ eventType: "action.auto_approved", message: `Action approuvée automatiquement (risque ${risk})`, actionId: row.id, emailId: row.source_email_id }, db);
  }
  return actionsRepo.getAction(row.id, db) as ActionRow;
}

function extractProposedReply(type: ActionType, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (type === "reply_email" || type === "send_followup" || type === "payment_request" || type === "deposit_request" || type === "send_email" || type === "prepare_reply") {
    return typeof p.body === "string" ? p.body : null;
  }
  if (type === "sign_document") return typeof p.reply_body === "string" ? p.reply_body : null;
  return null;
}

/* Décision --------------------------------------------------------------- */

export function approveAction(actionId: string, decidedBy: string, opts: EngineOptions = {}): ActionRow {
  const { db } = resolve(opts);
  const action = requireAction(actionId, db);
  const pending = approvalsRepo.getPendingApprovalForAction(actionId, db);
  if (pending) approvalsRepo.decideApproval(pending.id, "APPROVED", decidedBy, null, db);
  const ok = actionsRepo.transitionAction(actionId, ["WAITING_APPROVAL", "PROPOSED"], "APPROVED", { approved_at: nowIso() }, db);
  if (!ok) throw new EmaError("INVALID_TRANSITION", `Action ${actionId} en statut ${action.status} : validation impossible`);
  logHistory({ eventType: "approval.approved", message: `Validation reçue (${decidedBy})`, actor: decidedBy === "whatsapp" ? "whatsapp" : "user", actionId, emailId: action.source_email_id, approvalId: pending?.id ?? null }, db);
  return actionsRepo.getAction(actionId, db) as ActionRow;
}

export function rejectAction(actionId: string, decidedBy: string, reason?: string, opts: EngineOptions = {}): ActionRow {
  const { db } = resolve(opts);
  const action = requireAction(actionId, db);
  const pending = approvalsRepo.getPendingApprovalForAction(actionId, db);
  if (pending) approvalsRepo.decideApproval(pending.id, "REJECTED", decidedBy, reason ?? null, db);
  const ok = actionsRepo.transitionAction(actionId, ["WAITING_APPROVAL", "PROPOSED", "APPROVED"], "REJECTED", { completed_at: nowIso(), error: reason ?? null }, db);
  if (!ok) throw new EmaError("INVALID_TRANSITION", `Action ${actionId} en statut ${action.status} : refus impossible`);
  logHistory({ eventType: "approval.rejected", message: `Action refusée (${decidedBy})${reason ? ` : ${reason}` : ""}`, actor: decidedBy === "whatsapp" ? "whatsapp" : "user", actionId, emailId: action.source_email_id, approvalId: pending?.id ?? null }, db);
  return actionsRepo.getAction(actionId, db) as ActionRow;
}

/** Expire les validations en attente échues → actions REJECTED. */
export function expireApprovals(opts: EngineOptions = {}): number {
  const { db } = resolve(opts);
  let n = 0;
  for (const apr of approvalsRepo.listExpiredPendingApprovals(nowIso(), db)) {
    if (approvalsRepo.decideApproval(apr.id, "EXPIRED", "system", "Délai de validation dépassé", db)) {
      actionsRepo.transitionAction(apr.action_id, ["WAITING_APPROVAL", "PROPOSED"], "REJECTED", { completed_at: nowIso(), error: "Validation expirée" }, db);
      logHistory({ eventType: "approval.expired", message: "Validation expirée, action annulée", actor: "system", actionId: apr.action_id, approvalId: apr.id }, db);
      n++;
    }
  }
  return n;
}

/* Exécution (idempotente) ------------------------------------------------ */

export async function executeAction(actionId: string, opts: EngineOptions = {}): Promise<ActionRow> {
  const { db } = resolve(opts);
  const action = requireAction(actionId, db);
  if (action.status === "WAITING_APPROVAL" || action.status === "PROPOSED") {
    throw new EmaError("APPROVAL_REQUIRED", `L'action ${actionId} n'a pas été validée (statut ${action.status})`);
  }
  if (action.status !== "APPROVED") {
    throw new EmaError("CONFLICT", `Action ${actionId} déjà en cours ou terminée (statut ${action.status})`);
  }
  // Transition atomique : une seule exécution possible.
  const claimed = actionsRepo.transitionAction(actionId, "APPROVED", "EXECUTING", { executed_at: nowIso() }, db);
  if (!claimed) {
    throw new EmaError("CONFLICT", `Action ${actionId} déjà en cours ou terminée (statut ${action.status})`);
  }
  const type = actionTypeSchema.parse(action.type);
  const executor = executors.get(type);
  if (!executor) {
    actionsRepo.transitionAction(actionId, "EXECUTING", "FAILED", { completed_at: nowIso(), error: `Aucun exécuteur pour ${type}` }, db);
    logHistory({ eventType: "action.failed", message: `Aucun exécuteur enregistré pour ${type}`, actor: "system", actionId, emailId: action.source_email_id }, db);
    return actionsRepo.getAction(actionId, db) as ActionRow;
  }
  const payload = ACTION_PAYLOAD_SCHEMAS[type].parse(parseJson(action.payload, {}));
  try {
    const result = await executor.execute(payload, {
      actionId,
      companyId: action.company_id,
      documentId: action.document_id,
      sourceEmailId: action.source_email_id,
    });
    const finalStatus: ActionStatus = result.ok ? "COMPLETED" : "FAILED";
    actionsRepo.transitionAction(actionId, "EXECUTING", finalStatus, { completed_at: nowIso(), error: result.ok ? null : result.summary, result: JSON.stringify(result.data ?? null) }, db);
    logHistory({ eventType: result.ok ? "action.completed" : "action.failed", message: result.summary, actor: "ema", actionId, emailId: action.source_email_id, details: result.data }, db);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    actionsRepo.transitionAction(actionId, "EXECUTING", "FAILED", { completed_at: nowIso(), error: message }, db);
    logHistory({ eventType: "action.failed", message: `Échec : ${message}`, actor: "system", actionId, emailId: action.source_email_id }, db);
    log.error("action execution failed", { actionId, type, message });
  }
  return actionsRepo.getAction(actionId, db) as ActionRow;
}

/** Valide + exécute en une fois (webhook WhatsApp, bouton UI). */
export async function approveAndExecute(actionId: string, decidedBy: string, opts: EngineOptions = {}): Promise<ActionRow> {
  approveAction(actionId, decidedBy, opts);
  return executeAction(actionId, opts);
}

/* Utilitaires ------------------------------------------------------------ */

function requireAction(id: string, db: Db): ActionRow {
  const a = actionsRepo.getAction(id, db);
  if (!a) throw new EmaError("NOT_FOUND", `Action ${id} introuvable`);
  return a;
}

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
