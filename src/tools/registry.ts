import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { EmaError, toEmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import type { ToolContext, ToolDefinition, ToolMode, ToolResult } from "./types";

const log = createLogger("tools");

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (registry.has(def.name)) throw new Error(`Tool déjà enregistré : ${def.name}`);
  registry.set(def.name, def);
}

export function registerTools(defs: ToolDefinition[]): void {
  for (const d of defs) registerTool(d);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(mode?: ToolMode): ToolDefinition[] {
  const all = [...registry.values()];
  if (!mode) return all;
  return all.filter((t) => t.modes.includes(mode) && !t.modes.includes("internal"));
}

export function clearTools(): void {
  registry.clear();
}

/** Définitions au format Anthropic (nom, description, JSON Schema d'entrée). Rien d'autre. */
export function toAnthropicTools(mode: ToolMode): Anthropic.Tool[] {
  return listTools(mode).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.input, { target: "draft-7" }) as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Exécute un tool appelé par Claude : validation de l'entrée, exécution,
 * validation de la sortie, erreur assainie. Ne lève jamais vers l'appelant.
 */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: { code: "NOT_FOUND", message: `Tool inconnu : ${name}` } };
  if (!tool.modes.includes(ctx.mode)) return { ok: false, error: { code: "FORBIDDEN", message: `Tool ${name} indisponible en mode ${ctx.mode}` } };

  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: `Entrée invalide : ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` },
    };
  }
  try {
    const out = await tool.handler(parsed.data, ctx);
    const checked = tool.output.safeParse(out);
    if (!checked.success) {
      log.error("tool output invalid", { tool: name, issues: checked.error.issues.map((i) => i.message) });
      return { ok: false, error: { code: "INTERNAL", message: "Sortie du tool invalide" } };
    }
    return { ok: true, data: checked.data };
  } catch (err) {
    const e = err instanceof EmaError ? err : toEmaError(err);
    log.warn("tool failed", { tool: name, code: e.code, message: e.message });
    return { ok: false, error: { code: e.code, message: e.message } };
  }
}
