import { registerExecutor } from "../engine";
import type { ActionExecutor, ActionType } from "../types";
import { NotImplementedError } from "@/lib/errors";
import { createOutlookExecutors } from "./outlook";

/**
 * Enregistrement des exécuteurs. Les envois Outlook (reply/forward/send et les
 * emails internes de paiement) sont réels depuis la phase 1 ; les autres types
 * échouent proprement (NotImplementedError) jusqu'à leur phase.
 */
const PLANNED_PHASE: Partial<Record<ActionType, string>> = {
  prepare_reply: "phase 2",
  archive: "phase 4",
  send_followup: "phase 6",
  sign_document: "phase 5",
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

export function registerDefaultExecutors(): void {
  if (registered) return;
  for (const [type, phase] of Object.entries(PLANNED_PHASE) as [ActionType, string][]) registerExecutor(stub(type, phase));
  for (const ex of createOutlookExecutors()) registerExecutor(ex);
  registered = true;
}
