import Anthropic, { type ParsedMessage } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { insertLlmRun } from "@/database/repositories/llm-runs";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { getAnthropicClient, getModel } from "./client";

const log = createLogger("anthropic");

/** Sous-ensemble du SDK utilisé (injectable dans les tests). */
export type StructuredClient = Pick<Anthropic, "messages">;

export interface StructuredRequest<S extends z.ZodType> {
  operation: string;
  emailId?: string | null;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
}

export interface StructuredDeps {
  client?: StructuredClient;
  db?: Db;
  model?: string;
}

export class LlmError extends EmaError {
  readonly kind: "auth" | "rate_limit" | "transient" | "timeout" | "invalid_response" | "refusal" | "not_found" | "request";
  readonly retryable: boolean;
  constructor(kind: LlmError["kind"], message: string, retryable: boolean, cause?: unknown) {
    super(kind === "invalid_response" ? "VALIDATION" : "INTEGRATION", message, { status: 502, cause });
    this.name = "LlmError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** Traduit une erreur SDK en LlmError assainie (jamais de clé, message borné). */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new LlmError("auth", "Clé API Anthropic invalide", false, err);
  if (err instanceof Anthropic.PermissionDeniedError) return new LlmError("auth", "Accès refusé par l'API Anthropic", false, err);
  if (err instanceof Anthropic.NotFoundError) return new LlmError("not_found", "Modèle Anthropic introuvable ou indisponible", false, err);
  if (err instanceof Anthropic.RateLimitError) return new LlmError("rate_limit", "Limite de débit Anthropic atteinte", true, err);
  if (err instanceof Anthropic.InternalServerError) return new LlmError("transient", "Erreur serveur Anthropic", true, err);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("timeout", "Délai d'attente Anthropic dépassé", true, err);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError("transient", "Connexion à l'API Anthropic impossible", true, err);
  if (err instanceof Anthropic.BadRequestError) return new LlmError("request", `Requête refusée par l'API Anthropic : ${err.message.slice(0, 160)}`, false, err);
  if (err instanceof Anthropic.APIError) return new LlmError(err.status && err.status >= 500 ? "transient" : "request", `Erreur API Anthropic (${err.status ?? "?"})`, Boolean(err.status && err.status >= 500), err);
  return new LlmError("transient", err instanceof Error ? err.message.slice(0, 200) : "Erreur inconnue", false, err);
}

/**
 * Appel Claude avec sortie structurée (JSON validé par zod). Le SDK gère déjà
 * les retries limités (429 / 5xx / réseau, maxRetries = 2) et le timeout.
 * Chaque appel est journalisé dans llm_runs (usage, durée, issue) sans contenu.
 */
export async function runStructured<S extends z.ZodType>(req: StructuredRequest<S>, deps: StructuredDeps = {}): Promise<StructuredResult<z.infer<S>>> {
  const db = deps.db ?? getDb();
  const model = deps.model ?? getModel();
  const client = deps.client ?? getAnthropicClient();
  const started = Date.now();
  const record = (status: "ok" | "error", extra: { usage?: Anthropic.Usage | null; stopReason?: string | null; error?: string }) => {
    insertLlmRun(
      {
        emailId: req.emailId ?? null,
        operation: req.operation,
        model,
        status,
        inputTokens: extra.usage?.input_tokens ?? null,
        outputTokens: extra.usage?.output_tokens ?? null,
        cacheReadTokens: extra.usage?.cache_read_input_tokens ?? null,
        cacheCreationTokens: extra.usage?.cache_creation_input_tokens ?? null,
        durationMs: Date.now() - started,
        stopReason: extra.stopReason ?? null,
        error: extra.error ?? null,
      },
      db,
    );
  };

  let response: ParsedMessage<z.infer<S>>;
  try {
    response = await client.messages.parse({
      model,
      max_tokens: req.maxTokens ?? 4096,
      // Prompt système stable en premier (mise en cache), contexte variable ensuite.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort ?? "medium", format: zodOutputFormat(req.schema) },
    });
  } catch (err) {
    const e = toLlmError(err);
    record("error", { error: `${e.kind}: ${e.message}` });
    log.warn("structured call failed", { operation: req.operation, kind: e.kind, emailId: req.emailId ?? null });
    throw e;
  }

  if (response.stop_reason === "refusal") {
    const e = new LlmError("refusal", "Le modèle a refusé la requête", false);
    record("error", { usage: response.usage, stopReason: response.stop_reason, error: e.message });
    throw e;
  }
  if (response.stop_reason === "max_tokens") {
    const e = new LlmError("invalid_response", "Réponse tronquée (max_tokens)", false);
    record("error", { usage: response.usage, stopReason: response.stop_reason, error: e.message });
    throw e;
  }
  const parsed = response.parsed_output;
  const check = parsed === null ? null : req.schema.safeParse(parsed);
  if (!check || !check.success) {
    const detail = check ? check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ") : "JSON absent ou invalide";
    const e = new LlmError("invalid_response", `Réponse du modèle invalide : ${detail}`, false);
    record("error", { usage: response.usage, stopReason: response.stop_reason, error: e.message });
    throw e;
  }
  record("ok", { usage: response.usage, stopReason: response.stop_reason });
  return {
    data: check.data as z.infer<S>,
    model: response.model ?? model,
    durationMs: Date.now() - started,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
