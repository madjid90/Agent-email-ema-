import { route, ok, currentUser } from "@/lib/api";
import { getPocState, refreshComposioConnection } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

/** État de la connexion Composio de l'utilisateur connecté (`?refresh=1` relit Composio). */
export const GET = route(async (req, _ctx, sessionUser) => {
  requirePoc();
  const user = currentUser(sessionUser);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return ok(refresh ? await refreshComposioConnection(user) : getPocState(user));
});
