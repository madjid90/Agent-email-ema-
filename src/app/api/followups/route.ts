import { route, ok, currentUser } from "@/lib/api";
import { listFollowups } from "@/database/repositories/followups";

export const GET = route(async (_req, _ctx, sessionUser) => ok(listFollowups({ limit: 200, userId: currentUser(sessionUser).id })));
