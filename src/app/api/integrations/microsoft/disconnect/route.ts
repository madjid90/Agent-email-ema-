import { route, ok, currentUser } from "@/lib/api";
import { disconnect, getOutlookStatus } from "@/integrations/microsoft";

export const POST = route(async (_req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  disconnect({ userId: user.id });
  return ok(getOutlookStatus(undefined, user.id));
});
