import { z } from "zod";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import * as approvalsRepo from "@/database/repositories/approvals";
import { logHistory } from "@/database/repositories/history";
import type { ActionRow, ActionStatus, ApprovalRow } from "@/database/types";
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

/**
 * Expire les validations en attente échues → approval EXPIRED. L'action reste
 * WAITING_APPROVAL (jamais exécutée sans décision) : l'utilisateur peut la
 * refuser, la valider depuis l'interface ou renvoyer une demande.
 */
export function expireApprovals(opts: EngineOptions = {}): number {
  const { db } = resolve(opts);
  let n = 0;
  for (const apr of approvalsRepo.listExpiredPendingApprovals(nowIso(), db)) {
    if (approvalsRepo.decideApproval(apr.id, "EXPIRED", "system", "Délai de validation dépassé", db)) {
      logHistory({ eventType: "approval.expired", message: "Demande de validation expirée (action toujours en attente, non exécutée)", actor: "system", actionId: apr.action_id, approvalId: apr.id }, db);
      n++;
    }
  }
  return n;
}

/**
 * Nouvelle demande de validation pour une action toujours en attente
 * (après expiration ou échec d'envoi). Refuse s'il existe déjà une demande PENDING.
 */
export function createApprovalRequest(actionId: string, opts: EngineOptions = {}): ApprovalRow {
  const { db, settings } = resolve(opts);
  const action = requireAction(actionId, db);
  if (action.status !== "WAITING_APPROVAL" && action.status !== "PROPOSED") throw new EmaError("INVALID_TRANSITION", `Action ${actionId} en statut ${action.status} : aucune validation à demander`);
  const pending = approvalsRepo.getPendingApprovalForAction(actionId, db);
  if (pending) return pending;
  const type = actionTypeSchema.parse(action.type);
  const approval = approvalsRepo.insertApproval(
    { actionId, channel: settings.approvals.channel, summary: action.title, proposedReply: extractProposedReply(type, parseJson(action.payload, {})), expiresAt: addHoursSafe(nowIso(), settings.approvals.expireAfterHours) },
    db,
  );
  logHistory({ eventType: "approval.requested", message: "Nouvelle demande de validation créée", actor: "user", actionId, emailId: action.source_email_id, approvalId: approval.id }, db);
  return approval;
}

/**
 * Modification manuelle du payload d'une action en attente (ex. brouillon
 * édité dans l'interface). Le texte modifié devient le payload définitif.
 */
export function editActionPayload(actionId: string, patch: Record<string, unknown>, actor: "user" | "ema" = "user", opts: EngineOptions = {}): ActionRow {
  const { db } = resolve(opts);
  const action = requireAction(actionId, db);
  if (action.status !== "WAITING_APPROVAL" && action.status !== "PROPOSED") throw new EmaError("INVALID_TRANSITION", `Action ${actionId} en statut ${action.status} : modification impossible`);
  const type = actionTypeSchema.parse(action.type);
  const merged = { ...parseJson<Record<string, unknown>>(action.payload, {}), ...patch };
  const parsed = (ACTION_PAYLOAD_SCHEMAS[type] as z.ZodTypeAny).safeParse(merged);
  if (!parsed.success) throw new EmaError("VALIDATION", "Payload modifié invalide", { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  actionsRepo.updateActionPayload(actionId, parsed.data, db);
  const pending = approvalsRepo.getPendingApprovalForAction(actionId, db);
  if (pending) approvalsRepo.updateApprovalProposedReply(pending.id, extractProposedReply(type, parsed.data), db);
  logHistory({ eventType: "action.payload_edited", message: `Brouillon modifié manuellement (${Object.keys(patch).join(", ")})`, actor, actionId, emailId: action.source_email_id, approvalId: pending?.id ?? null }, db);
  return actionsRepo.getAction(actionId, db) as ActionRow;
}

export interface RetryOptions extends EngineOptions {
  /**
   * `true` : l'utilisateur a vérifié lui-même dans Outlook et assume le renvoi.
   * Sans cela, une action au résultat ambigu n'est jamais rejouée.
   */
  force?: boolean;
  /** Client Graph utilisé pour la réconciliation (tests, worker). */
  client?: import("@/integrations/microsoft/graph-client").GraphClient | null;
  /** Réconciliation injectable (tests). */
  reconcile?: (action: ActionRow) => Promise<{ verdict: "sent" | "not_sent" | "unknown"; detail: string }>;
}

/**
 * Nouvelle tentative explicite d'une action FAILED (déjà validée).
 * Si le dernier échec est un envoi au résultat inconnu, EMA cherche d'abord la
 * trace réelle dans les éléments envoyés : message trouvé → action terminée sans
 * second envoi ; doute persistant → refus, vérification humaine demandée.
 */
export async function retryAction(actionId: string, actor: string, opts: RetryOptions = {}): Promise<ActionRow> {
  const { db } = resolve(opts);
  const action = requireAction(actionId, db);

  if (action.error_code === "DELIVERY_AMBIGUOUS" && !opts.force) {
    const { reconcileAction, AMBIGUOUS_MESSAGE } = await import("./recovery");
    const check = opts.reconcile ? await opts.reconcile(action) : await reconcileAction(action, { db, settings: opts.settings, client: opts.client });
    if (check.verdict === "sent") {
      actionsRepo.transitionAction(actionId, "FAILED", "COMPLETED", { completed_at: nowIso(), error: null, error_code: null, result: JSON.stringify({ reconciled: true, detail: check.detail }) }, db);
      logHistory({ eventType: "action.reconciled", message: `Envoi déjà effectué (${check.detail}) : aucun second envoi`, actor: "user", actionId, emailId: action.source_email_id }, db);
      return actionsRepo.getAction(actionId, db) as ActionRow;
    }
    if (check.verdict === "unknown") {
      logHistory({ eventType: "action.ambiguous", message: `Nouvelle tentative refusée : ${check.detail}`, actor: "user", actionId, emailId: action.source_email_id }, db);
      throw new EmaError("CONFLICT", `${AMBIGUOUS_MESSAGE} (${check.detail})`);
    }
  }

  if (!actionsRepo.transitionAction(actionId, "FAILED", "APPROVED", { error: null, error_code: null, completed_at: null }, db)) {
    throw new EmaError("INVALID_TRANSITION", `Action ${actionId} en statut ${action.status} : nouvelle tentative impossible`);
  }
  logHistory({ eventType: "action.retry", message: `Nouvelle tentative demandée (${actor})${opts.force ? " après vérification humaine" : ""}`, actor: "user", actionId, emailId: action.source_email_id }, db);
  return executeAction(actionId, opts);
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
    actionsRepo.transitionAction(actionId, "EXECUTING", finalStatus, { completed_at: nowIso(), error: result.ok ? null : result.summary, error_code: result.ok ? null : "EXECUTION_FAILED", result: JSON.stringify(result.data ?? null) }, db);
    logHistory({ eventType: result.ok ? "action.completed" : "action.failed", message: result.summary, actor: "ema", actionId, emailId: action.source_email_id, details: result.data }, db);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    // Envoi au résultat inconnu : l'action est marquée comme telle et ne sera
    // jamais rejouée automatiquement (voir src/actions/recovery.ts).
    const ambiguous = err instanceof EmaError && err.code === "DELIVERY_AMBIGUOUS";
    actionsRepo.transitionAction(actionId, "EXECUTING", "FAILED", { completed_at: nowIso(), error: message, error_code: ambiguous ? "DELIVERY_AMBIGUOUS" : "EXECUTION_FAILED" }, db);
    logHistory({ eventType: ambiguous ? "action.ambiguous" : "action.failed", message: ambiguous ? `Envoi au résultat inconnu : ${message}` : `Échec : ${message}`, actor: "system", actionId, emailId: action.source_email_id }, db);
    log.error("action execution failed", { actionId, type, message, ambiguous });
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
