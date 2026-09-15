import type { RiskLevel } from "@/database/types";
import { DEFAULT_RISK, RISK_ORDER, type ActionType } from "./types";
import type { Settings } from "@/lib/config";

/** Niveau final = max(défaut du type, niveau demandé). Jamais en dessous du défaut. */
export function resolveRiskLevel(type: ActionType, requested?: RiskLevel): RiskLevel {
  const base = DEFAULT_RISK[type];
  if (!requested) return base;
  return RISK_ORDER[requested] > RISK_ORDER[base] ? requested : base;
}

/**
 * Règle de validation (CLAUDE.md §5.4, BUSINESS_RULES.md §3) :
 * - HIGH / CRITICAL → toujours.
 * - demande explicite → oui.
 * - envoi d'email (MEDIUM) → oui sauf autoReplyEnabled.
 * - LOW → non.
 */
export function requiresApproval(type: ActionType, risk: RiskLevel, explicit: boolean | undefined, settings: Pick<Settings, "agent">): boolean {
  if (risk === "HIGH" || risk === "CRITICAL") return true;
  if (explicit) return true;
  if (risk === "MEDIUM") {
    const isSend = type === "reply_email" || type === "forward_email" || type === "send_email" || type === "send_followup";
    if (isSend) return !settings.agent.autoReplyEnabled;
    return true;
  }
  return false;
}
