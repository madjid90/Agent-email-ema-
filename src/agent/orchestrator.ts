import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { NotImplementedError } from "@/lib/errors";
import { emailAnalysisSchema, type EmailAnalysis } from "./schemas";
import { buildEmailContext, renderEmailContext } from "./context";
import { getPrompt, getSystemPrompt } from "./prompts";

/**
 * Orchestrateur : construit le contexte, appelle Claude avec les tools du mode,
 * valide la sortie structurée et enregistre l'analyse + les actions proposées.
 *
 * Phase 0 : contrat et préparation du prompt. L'appel Claude (structured output
 * + boucle tool calling) est implémenté en phase 2.
 */
export interface AnalyzeResult {
  analysis: EmailAnalysis;
  actionIds: string[];
  model: string;
}

export interface PreparedAnalysisRequest {
  system: string;
  instructions: string;
  context: string;
  injectionSuspected: boolean;
}

/** Prépare la requête (sans appel réseau) : utile pour les tests et le débogage. */
export function prepareAnalysisRequest(emailId: string, db: Db = getDb()): PreparedAnalysisRequest {
  const ctx = buildEmailContext(emailId, db);
  return {
    system: getSystemPrompt(),
    instructions: getPrompt("analyze-email"),
    context: renderEmailContext(ctx),
    injectionSuspected: ctx.injectionSuspected,
  };
}

export async function analyzeEmail(_emailId: string, _db: Db = getDb()): Promise<AnalyzeResult> {
  throw new NotImplementedError("Analyse d'email par Claude", "phase 2");
}

export function validateAnalysis(raw: unknown): EmailAnalysis {
  return emailAnalysisSchema.parse(raw);
}
