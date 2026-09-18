import { route, ok, currentUser } from "@/lib/api";
import { listPocTools } from "@/integrations/composio/outlook-poc";
import { summarizeTools } from "@/integrations/composio/policy";
import { requirePoc } from "../_guard";

/**
 * Diagnostic : tools du toolkit Outlook en trois catégories (exécutables /
 * lecture non retenue / écriture-destructifs refusés) + résumé. Invariant :
 * `summary.writeToolsExecutable === 0`, sinon `summary.pocFailed`. Aucun secret.
 */
export const GET = route(async (_req, _ctx, sessionUser) => {
  requirePoc();
  currentUser(sessionUser);
  const classified = await listPocTools();
  const { allowed, readOnlyUnused, blocked } = classified;
  const view = (t: { slug: string; name: string; description: string; inputParameters: string[]; requiredParameters: string[] }) => ({ slug: t.slug, name: t.name, description: t.description, parameters: t.inputParameters, required: t.requiredParameters });
  return ok({ allowed: allowed.map(view), readOnlyUnused: readOnlyUnused.map(view), blocked: blocked.map(view), summary: summarizeTools(classified) });
});
