import { route, ok } from "@/lib/api";
import { getOutlookStatus, testOutlookConnection } from "@/integrations/microsoft";

export const GET = route(async (req) => {
  const test = new URL(req.url).searchParams.get("test") === "1";
  const status = getOutlookStatus();
  return ok({ ...status, test: test ? await testOutlookConnection() : null });
});
