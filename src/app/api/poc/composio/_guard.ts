import { EmaError } from "@/lib/errors";
import { isComposioPocEnabled } from "@/integrations/composio/outlook-poc";

/** POC désactivé : les routes n'existent pas (404), EMA se comporte exactement comme avant. */
export function requirePoc(): void {
  if (!isComposioPocEnabled()) throw new EmaError("NOT_FOUND", "POC Composio désactivé");
}
