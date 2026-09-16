import { registerExecutor } from "../engine";
import type { ActionExecutor, ActionType } from "../types";
import { NotImplementedError } from "@/lib/errors";
import { createOutlookExecutors } from "./outlook";
import { createSigningExecutor } from "./signing";

/**
 * Enregistrement des exécuteurs. Les envois Outlook (reply/forward/send et les
 * emails internes de paiement) sont réels depuis la phase 1 ; les autres types
 * échouent proprement (NotImplementedError) jusqu'à leur phase.
 */
const PLANNED_PHASE: Partial<Record<ActionType, string>> = {
  archive: "phase 4",
  send_followup: "phase 6",
};

function stub(type: ActionType, phase: string): ActionExecutor {
  return {
    type,
    async execute() {
      throw new NotImplementedError(`Exécuteur ${type}`, phase);
    },
  };
}

let registered = false;

/** Brouillon de réponse : aucun effet de bord, la trace suffit (phase 2). */
const prepareReply: ActionExecutor<"prepare_reply"> = {
  type: "prepare_reply",
  async execute(payload) {
    return { ok: true, summary: "Brouillon de réponse préparé (aucun envoi)", data: { chars: payload.body.length } };
  },
};

/** Oublie l'enregistrement (tests uniquement), symétrique de `resetToolsForTests`. */
export function resetDefaultExecutorsForTests(): void {
  registered = false;
}

export function registerDefaultExecutors(): void {
  if (registered) return;
  registerExecutor(prepareReply as ActionExecutor);
  for (const [type, phase] of Object.entries(PLANNED_PHASE) as [ActionType, string][]) registerExecutor(stub(type, phase));
  for (const ex of createOutlookExecutors()) registerExecutor(ex);
  registerExecutor(createSigningExecutor() as ActionExecutor);
  registered = true;
}
