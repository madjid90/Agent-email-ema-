import { route, ok } from "@/lib/api";
import { listFollowups } from "@/database/repositories/followups";

export const GET = route(async () => ok(listFollowups({ limit: 200 })));
