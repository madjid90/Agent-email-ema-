import { route, ok, currentUser } from "@/lib/api";
import { disconnectComposio } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

export const POST = route(async (_req, _ctx, sessionUser) => {
  requirePoc();
  return ok(await disconnectComposio(currentUser(sessionUser)));
});
