import { registerTools, clearTools } from "./registry";
import { outlookTools } from "./outlook";
import { documentTools } from "./documents";
import { paymentTools } from "./payments";
import { followupTools } from "./followups";
import { approvalTools } from "./approvals";
import { signatureTools } from "./signatures";
import { whatsappTools } from "./whatsapp";

let ready = false;

/** Enregistre tous les tools une seule fois par process. */
export function registerAllTools(): void {
  if (ready) return;
  clearTools();
  registerTools([...outlookTools, ...documentTools, ...paymentTools, ...followupTools, ...approvalTools, ...signatureTools, ...whatsappTools]);
  ready = true;
}

export function resetToolsForTests(): void {
  ready = false;
  clearTools();
}

export { listTools, executeTool, toAnthropicTools, getTool } from "./registry";
export * from "./types";
