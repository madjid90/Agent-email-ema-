import { route, ok, currentUser } from "@/lib/api";
import { listPocTools } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

/** Diagnostic : tools du toolkit Outlook classés autorisés (lecture) / refusés (écriture). Aucun secret. */
export const GET = route(async (_req, _ctx, sessionUser) => {
  requirePoc();
  currentUser(sessionUser);
  const { allowed, blocked } = await listPocTools();
  const view = (t: { slug: string; name: string; description: string; inputParameters: string[]; requiredParameters: string[] }) => ({ slug: t.slug, name: t.name, description: t.description, parameters: t.inputParameters, required: t.requiredParameters });
  return ok({ allowed: allowed.map(view), blocked: blocked.map(view) });
});
