import { route, ok, currentUser } from "@/lib/api";
import { getOutlookStatus, testOutlookConnection } from "@/integrations/microsoft";

export const GET = route(async (req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const test = new URL(req.url).searchParams.get("test") === "1";
  const status = getOutlookStatus(undefined, user.id);
  return ok({ ...status, test: test ? await testOutlookConnection(undefined, user.id) : null });
});
