import { route, ok, currentUser } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { startComposioConnection } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

/** Démarre le parcours OAuth Composio/Microsoft pour LE compte connecté ; renvoie l'URL à ouvrir. */
export const POST = route(async (_req, _ctx, sessionUser) => {
  requirePoc();
  const user = currentUser(sessionUser);
  const callbackUrl = `${getEnv().APP_URL.replace(/\/+$/, "")}/api/poc/composio/callback`;
  const r = await startComposioConnection(user, callbackUrl);
  return ok({ redirectUrl: r.redirectUrl });
});
