import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { testComponent, testAllComponents } from "@/lib/status";

export const POST = route(async (req) => {
  const { component } = await parseBody(req, z.object({ component: z.enum(["claude", "outlook", "whatsapp", "sqlite", "pdf", "worker", "all"]) }));
  if (component === "all") return ok(await testAllComponents());
  return ok(await testComponent(component));
});
