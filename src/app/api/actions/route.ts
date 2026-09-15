import { route, ok } from "@/lib/api";
import { listActions } from "@/database/repositories/actions";
import type { ActionStatus } from "@/database/types";

export const GET = route(async (req) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") as ActionStatus | null;
  return ok(listActions({ status: status ?? undefined, limit: 200 }));
});
