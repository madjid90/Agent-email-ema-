import type { ChatOutcome } from "./fake-anthropic";

/** Tour de chat simulé : Claude appelle un tool puis répond en texte. */
export function toolTurn(name: string, input: Record<string, unknown>, id = `tu_${name}`): ChatOutcome {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}

export function textTurn(text: string): ChatOutcome {
  return { stop_reason: "end_turn", content: [{ type: "text", text, citations: null }] };
}

/** Enchaînement classique : un appel de tool puis la réponse finale. */
export function turn(name: string, input: Record<string, unknown>, reply: string): ChatOutcome[] {
  return [toolTurn(name, input), textTurn(reply)];
}

/** Texte du prompt système réellement envoyé à Claude (audit des fuites). */
export function systemTextOf(params: Record<string, unknown>): string {
  const system = params.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n");
  return "";
}

/** Noms des tools exposés à Claude lors d'un appel. */
export function toolNamesOf(params: Record<string, unknown>): string[] {
  return Array.isArray(params.tools) ? (params.tools as { name: string }[]).map((t) => t.name) : [];
}
