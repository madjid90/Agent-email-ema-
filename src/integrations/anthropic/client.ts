import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";

/**
 * Seul point d'accès au SDK Anthropic. La clé API est lue ici et nulle part ailleurs.
 */
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (client) return client;
  const key = getEnv().ANTHROPIC_API_KEY;
  if (!key) throw new EmaError("CONFIG", "ANTHROPIC_API_KEY manquante");
  client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
  return client;
}

export function getModel(): string {
  return getEnv().ANTHROPIC_MODEL;
}

export function resetAnthropicClient(): void {
  client = null;
}

export interface ConnectionTestResult {
  ok: boolean;
  model: string;
  message: string;
}

/** Test de connexion minimal (setup, page Test). */
export async function testAnthropicConnection(): Promise<ConnectionTestResult> {
  const model = getModel();
  try {
    const c = getAnthropicClient();
    const res = await c.messages.create({
      model,
      max_tokens: 32,
      messages: [{ role: "user", content: "Réponds uniquement par OK." }],
    });
    if (res.stop_reason === "refusal") return { ok: false, model, message: "Requête refusée par le modèle" };
    const text = res.content.find((b) => b.type === "text");
    return { ok: true, model, message: text && text.type === "text" ? text.text.trim().slice(0, 40) : "Réponse reçue" };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, model, message: "Clé API invalide" };
    if (err instanceof Anthropic.NotFoundError) return { ok: false, model, message: `Modèle introuvable : ${model}` };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, model, message: "Limite de débit atteinte, réessayer" };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, model, message: "Connexion à l'API impossible" };
    if (err instanceof EmaError) return { ok: false, model, message: err.message };
    return { ok: false, model, message: err instanceof Error ? err.message : "Erreur inconnue" };
  }
}
