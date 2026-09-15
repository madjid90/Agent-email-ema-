import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as chatRepo from "@/database/repositories/chat";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { insertLlmRun } from "@/database/repositories/llm-runs";
import { getSettings, type Settings } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { getAnthropicClient, getModel } from "@/integrations/anthropic/client";
import { toLlmError, type StructuredClient } from "@/integrations/anthropic/structured";
import { executeTool, toAnthropicTools } from "@/tools";
import { toolContextFor } from "./context";
import { getPrompt, getSystemPrompt } from "./prompts";
import { CATEGORY_LABELS } from "./schemas";

const log = createLogger("chat");

/** Phase 2 : outils de LECTURE uniquement. Aucun outil à effet n'est exposé au chat. */
export const CHAT_READONLY_TOOLS = ["get_email", "get_email_thread", "search_emails", "get_email_analysis", "list_recent_emails", "get_approval_status"] as const;
const MAX_TURNS = 6;
const HISTORY_MESSAGES = 12;

export interface ChatDeps {
  db?: Db;
  settings?: Settings;
  client?: StructuredClient;
  model?: string;
}

export interface ChatTurnResult {
  reply: string;
  toolCalls: { name: string; ok: boolean }[];
}

/**
 * Un tour de chat : historique local borné + message utilisateur → Claude avec
 * outils de lecture (boucle bornée) → réponse texte enregistrée.
 */
export async function runChatTurn(userMessage: string, deps: ChatDeps = {}): Promise<ChatTurnResult> {
  const db = deps.db ?? getDb();
  const settings = deps.settings ?? getSettings();
  const client = deps.client ?? getAnthropicClient();
  const model = deps.model ?? getModel();

  chatRepo.insertChatMessage("user", userMessage, undefined, db);
  const history = chatRepo.listChatMessages(HISTORY_MESSAGES, db).filter((m) => m.role !== "tool");
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

  const tools = toAnthropicTools("chat").filter((t) => (CHAT_READONLY_TOOLS as readonly string[]).includes(t.name));
  const toolCtx = toolContextFor("chat", null, db);
  const system = `${getSystemPrompt()}\n\n${getPrompt("chat")}\n\nUtilisateur : ${settings.company.userName || ""} — ${settings.company.name || ""}. Date du jour : ${new Date().toISOString().slice(0, 10)}. Catégories EMA : ${Object.entries(CATEGORY_LABELS)
    .map(([k, v]) => `${k} = ${v}`)
    .join(", ")}.`;

  const toolCalls: ChatTurnResult["toolCalls"] = [];
  const started = Date.now();
  let finalText = "";
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        tools,
        output_config: { effort: "low" },
      });
      insertLlmRun({ operation: "chat", model, status: "ok", inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cacheReadTokens: response.usage.cache_read_input_tokens, cacheCreationTokens: response.usage.cache_creation_input_tokens, durationMs: Date.now() - started, stopReason: response.stop_reason }, db);

      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason === "refusal") {
        finalText = "Je ne peux pas traiter cette demande.";
        break;
      }
      if (uses.length === 0 || response.stop_reason !== "tool_use") {
        finalText = text || "Je n'ai pas de réponse à proposer.";
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const r = await executeTool(use.name, use.input, toolCtx);
        toolCalls.push({ name: use.name, ok: r.ok });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(r.ok ? r.data : { error: r.error }).slice(0, 20_000), is_error: !r.ok });
      }
      messages.push({ role: "user", content: results });
      if (turn === MAX_TURNS - 1) finalText = text || "J'ai atteint la limite d'étapes pour cette question. Pouvez-vous la préciser ?";
    }
  } catch (err) {
    const e = toLlmError(err);
    insertLlmRun({ operation: "chat", model, status: "error", durationMs: Date.now() - started, error: `${e.kind}: ${e.message}` }, db);
    log.warn("chat turn failed", { kind: e.kind });
    throw e;
  }
  chatRepo.insertChatMessage("assistant", finalText, toolCalls.length ? toolCalls : undefined, db);
  return { reply: finalText, toolCalls };
}

/** Explication locale d'une analyse (sans appel LLM) : utilisée par le tool get_email_analysis. */
export function describeAnalysis(emailId: string, db: Db = getDb()): Record<string, unknown> | null {
  const a = getLatestAnalysis(emailId, db);
  if (!a) return null;
  return {
    email_id: a.email_id,
    category: a.category,
    category_label: CATEGORY_LABELS[a.category as keyof typeof CATEGORY_LABELS] ?? a.category,
    urgency: a.urgency,
    summary: a.summary,
    company_id: a.company_id,
    company_name: a.company_name,
    requested_action: a.requested_action,
    amount: a.amount_value,
    currency: a.amount_currency,
    due_date: a.due_date,
    needs_reply: a.needs_reply === 1,
    recommended_action: a.recommended_action,
    forward_to: a.forward_to,
    confidence: a.confidence,
    requires_human_review: a.requires_human_review === 1,
    reply_draft: a.reply_draft,
    reasoning_summary: a.reasoning_summary,
    analyzed_at: a.created_at,
    model: a.model,
  };
}
