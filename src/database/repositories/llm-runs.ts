import type { Db } from "../connection";
import { getDb } from "../connection";
import type { LlmRunRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewLlmRun {
  emailId?: string | null;
  operation: string;
  model: string;
  status: "ok" | "error";
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  durationMs: number;
  stopReason?: string | null;
  error?: string | null;
}

/** Journal des appels Claude : usage et issue, jamais le contenu ni la clé. */
export function insertLlmRun(input: NewLlmRun, db: Db = getDb()): LlmRunRow {
  const id = newId("llm");
  db.prepare(
    `INSERT INTO llm_runs (id, email_id, operation, model, status, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, stop_reason, error, created_at)
     VALUES (@id, @email_id, @operation, @model, @status, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @duration_ms, @stop_reason, @error, @created_at)`,
  ).run({
    id,
    email_id: input.emailId ?? null,
    operation: input.operation,
    model: input.model,
    status: input.status,
    input_tokens: input.inputTokens ?? null,
    output_tokens: input.outputTokens ?? null,
    cache_read_tokens: input.cacheReadTokens ?? null,
    cache_creation_tokens: input.cacheCreationTokens ?? null,
    duration_ms: Math.round(input.durationMs),
    stop_reason: input.stopReason ?? null,
    error: input.error ? input.error.slice(0, 500) : null,
    created_at: nowIso(),
  });
  return db.prepare("SELECT * FROM llm_runs WHERE id = ?").get(id) as LlmRunRow;
}

export function listLlmRuns(opts: { emailId?: string; limit?: number } = {}, db: Db = getDb()): LlmRunRow[] {
  if (opts.emailId) return db.prepare("SELECT * FROM llm_runs WHERE email_id = ? ORDER BY created_at DESC LIMIT ?").all(opts.emailId, opts.limit ?? 20) as LlmRunRow[];
  return db.prepare("SELECT * FROM llm_runs ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 100) as LlmRunRow[];
}

export interface DailyUsage {
  day: string;
  runs: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

/** Consommation Claude par jour (diagnostic, mesure du coût des pilotes). */
export function llmUsageByDay(days = 14, db: Db = getDb()): DailyUsage[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM llm_runs WHERE created_at >= ? GROUP BY day ORDER BY day DESC`,
    )
    .all(since) as { day: string; runs: number; errors: number | null; input_tokens: number; output_tokens: number }[];
  return rows.map((r) => ({ day: r.day, runs: r.runs, errors: r.errors ?? 0, inputTokens: r.input_tokens, outputTokens: r.output_tokens }));
}

/** Consommation par opération (analyse email, document, chat, relance). */
export function llmUsageByOperation(since: string, db: Db = getDb()): { operation: string; runs: number; inputTokens: number; outputTokens: number }[] {
  return db
    .prepare(
      `SELECT operation, COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
       FROM llm_runs WHERE created_at >= ? GROUP BY operation ORDER BY runs DESC`,
    )
    .all(since) as { operation: string; runs: number; inputTokens: number; outputTokens: number }[];
}

export function llmUsageSince(since: string, db: Db = getDb()): { runs: number; errors: number; inputTokens: number; outputTokens: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS runs, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM llm_runs WHERE created_at >= ?`,
    )
    .get(since) as { runs: number; errors: number | null; input_tokens: number; output_tokens: number };
  return { runs: row.runs, errors: row.errors ?? 0, inputTokens: row.input_tokens, outputTokens: row.output_tokens };
}
