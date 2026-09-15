import { route, ok } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { createConnectedGraphClient, isOutlookConnected, syncInbox } from "@/integrations/microsoft";
import { acquireLock, releaseLock } from "@/database/repositories/locks";
import { newId } from "@/lib/ids";

/** Synchronisation manuelle (bouton UI). Même verrou que le worker. */
export const POST = route(async () => {
  if (!isOutlookConnected()) throw new EmaError("CONFIG", "Outlook n'est pas connecté");
  const owner = newId("ui");
  if (!acquireLock("task:scan_mailbox", owner, 300)) throw new EmaError("CONFLICT", "Une synchronisation est déjà en cours");
  try {
    return ok(await syncInbox(createConnectedGraphClient()));
  } finally {
    releaseLock("task:scan_mailbox", owner);
  }
});
