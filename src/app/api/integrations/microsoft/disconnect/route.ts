import { route, ok } from "@/lib/api";
import { disconnect, getOutlookStatus } from "@/integrations/microsoft";

export const POST = route(async () => {
  disconnect();
  return ok(getOutlookStatus());
});
