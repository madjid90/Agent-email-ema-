import { route, ok, currentUser } from "@/lib/api";
import { listActions } from "@/database/repositories/actions";
import type { ActionStatus } from "@/database/types";

export const GET = route(async (req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const url = new URL(req.url);
  const status = url.searchParams.get("status") as ActionStatus | null;
  return ok(listActions({ status: status ?? undefined, limit: 200, userId: user.id }));
});
