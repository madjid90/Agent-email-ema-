import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import { getSettings, type Settings } from "@/lib/config";
import { formatAmount } from "@/lib/time";
import type { StructuredClient } from "@/integrations/anthropic/structured";
import type { ToolResult } from "@/tools";
import { runChatTurn, type ChatTurnResult } from "./chat";
import { getPrompt } from "./prompts";
import { describeRefs, lastRefs, numberRefs, refsFromToolResult, type ConversationRef } from "./references";

/**
 * Assistant conversationnel WhatsApp (phase 6). Il réutilise le Chat EMA :
 * même boucle de tool calling, même Context Engine, mêmes tools. La différence
 * tient à la liste d'outils exposés (lecture + préparation d'actions), au
 * contexte conversationnel borné (références numérotées, actions en attente) et
 * au canal de persistance (chat_messages, channel = WHATSAPP).
 *
 * Aucun effet externe direct : les outils de préparation créent des actions
 * dans l'Action Engine, validées ensuite par l'utilisateur.
 */

/** Outils exposés à l'assistant WhatsApp. Aucune primitive d'envoi ou de signature. */
export const WHATSAPP_READ_TOOLS = [
  "get_email",
  "get_email_thread",
  "search_emails",
  "get_email_analysis",
  "list_recent_emails",
  "search_documents",
  "get_document",
  "search_contacts",
  "get_company",
  "list_pending_actions",
  "get_approval_status",
  "get_today_summary",
] as const;

/** Outils de préparation : ils créent une action soumise à validation, jamais un envoi. */
export const WHATSAPP_PREPARE_TOOLS = ["reply_email", "forward_email", "send_email", "prepare_document_forward", "prepare_payment_request", "prepare_deposit_request", "prepare_signed_document", "update_draft"] as const;

export const WHATSAPP_TOOLS = [...WHATSAPP_READ_TOOLS, ...WHATSAPP_PREPARE_TOOLS] as const;

const HISTORY_MESSAGES = 8;

export interface AssistantDeps {
  db?: Db;
  settings?: Settings;
  client?: StructuredClient;
  model?: string;
  externalId?: string | null;
  sender?: string | null;
}

export interface AssistantTurnResult extends ChatTurnResult {
  /** Actions créées pendant ce tour (à notifier pour validation). */
  newActionIds: string[];
  refs: ConversationRef[];
}

function pendingSnapshot(db: Db): Set<string> {
  return new Set(actionsRepo.listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: 100 }, db).map((a) => a.id));
}

/** Contexte borné injecté dans le prompt : jamais toute la mailbox, jamais tout l'historique. */
function buildContext(db: Db, settings: Settings): string {
  const blocks: string[] = [];
  const pending = actionsRepo.listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: 5 }, db);
  if (pending.length > 0) {
    blocks.push(
      `Actions en attente de validation :\n${pending.map((a, i) => `${i + 1}. ${a.id} — ${a.title} (${a.type}, risque ${a.risk_level})`).join("\n")}`,
    );
  }
  const refs = lastRefs("WHATSAPP", db);
  const described = describeRefs(refs);
  if (described) blocks.push(described);
  blocks.push(`Canal : WhatsApp. Fuseau : ${settings.company.timezone}.`);
  return blocks.join("\n\n");
}

/** Un tour de conversation WhatsApp. Les erreurs LLM remontent (gérées par le routeur). */
export async function runWhatsappAssistantTurn(text: string, deps: AssistantDeps = {}): Promise<AssistantTurnResult> {
  const db = deps.db ?? getDb();
  const settings = deps.settings ?? getSettings();
  const before = pendingSnapshot(db);
  const collected: Omit<ConversationRef, "index">[] = [];
  let refs: ConversationRef[] = [];

  const onToolResult = (name: string, result: ToolResult<unknown>): void => {
    collected.push(...refsFromToolResult(name, result));
  };

  const result = await runChatTurn(text, {
    db,
    settings,
    client: deps.client,
    model: deps.model,
    channel: "WHATSAPP",
    toolNames: WHATSAPP_TOOLS,
    historyLimit: HISTORY_MESSAGES,
    systemExtra: `${getPrompt("whatsapp")}\n\n${buildContext(db, settings)}`,
    userMeta: { externalId: deps.externalId ?? null, sender: deps.sender ?? null },
    onToolResult,
    assistantMeta: () => {
      refs = numberRefs(collected);
      return { refs: refs.length ? refs : undefined };
    },
  });

  const newActionIds = actionsRepo
    .listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: 100 }, db)
    .filter((a) => !before.has(a.id))
    .map((a) => a.id)
    .reverse();

  return { ...result, newActionIds, refs };
}

/** Résumé court d'une action pour la confirmation WhatsApp. */
export function describeAction(actionId: string, db: Db = getDb()): string {
  const a = actionsRepo.getAction(actionId, db);
  if (!a) return "action inconnue";
  const payload = JSON.parse(a.payload) as Record<string, unknown>;
  const to = Array.isArray(payload.to) ? (payload.to as string[]).join(", ") : null;
  const amount = typeof payload.amount === "number" ? ` (${formatAmount(payload.amount, typeof payload.currency === "string" ? payload.currency : "EUR")})` : "";
  return `${a.title}${to ? ` → ${to}` : ""}${amount}`;
}
