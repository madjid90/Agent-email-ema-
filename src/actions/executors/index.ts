import { registerExecutor } from "../engine";
import type { ActionExecutor, ActionType } from "../types";
import { NotImplementedError } from "@/lib/errors";

/**
 * Enregistrement des exécuteurs. En phase 0, chaque type est branché sur un
 * exécuteur explicite qui échoue proprement (NotImplementedError) : l'Action
 * Engine, les validations et l'historique fonctionnent de bout en bout, sans
 * effet de bord réel. Les phases 1 à 6 remplacent ces stubs un par un.
 */
const PLANNED_PHASE: Record<ActionType, string> = {
  prepare_reply: "phase 2",
  archive: "phase 4",
  reply_email: "phase 1",
  forward_email: "phase 1",
  send_email: "phase 1",
  send_followup: "phase 6",
  payment_request: "phase 4",
  deposit_request: "phase 4",
  sign_document: "phase 5",
};

function stub(type: ActionType): ActionExecutor {
  return {
    type,
    async execute() {
      throw new NotImplementedError(`Exécuteur ${type}`, PLANNED_PHASE[type]);
    },
  };
}

let registered = false;

export function registerDefaultExecutors(): void {
  if (registered) return;
  for (const type of Object.keys(PLANNED_PHASE) as ActionType[]) registerExecutor(stub(type));
  registered = true;
}
