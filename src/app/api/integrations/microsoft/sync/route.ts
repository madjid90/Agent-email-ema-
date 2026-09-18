import { route, ok, currentUser } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { createConnectedGraphClient, isOutlookConnected, syncInbox } from "@/integrations/microsoft";
import { acquireLock, releaseLock } from "@/database/repositories/locks";
import { newId } from "@/lib/ids";

/** Synchronisation manuelle (bouton UI). Même verrou que le worker. */
export const POST = route(async (_req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  if (!isOutlookConnected(undefined, user.id)) throw new EmaError("MICROSOFT_RECONNECT", "Outlook n'est pas connecté. Connectez Outlook depuis Paramètres → Connexions.");
  const owner = newId("ui");
  if (!acquireLock("task:scan_mailbox", owner, 300)) throw new EmaError("CONFLICT", "Une synchronisation est déjà en cours");
  try {
    return ok(await syncInbox(createConnectedGraphClient({ userId: user.id }), { userId: user.id }));
  } finally {
    releaseLock("task:scan_mailbox", owner);
  }
});
