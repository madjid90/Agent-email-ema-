import { route, ok } from "@/lib/api";
import { testAllComponents } from "@/lib/status";
import { getConfiguredIntegrations } from "@/lib/env";

export const GET = route(async () => {
  const components = await testAllComponents();
  return ok({ integrations: getConfiguredIntegrations(), components, ready: components.every((c) => c.ok) });
});
