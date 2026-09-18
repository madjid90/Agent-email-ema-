import { route, ok, currentUser } from "@/lib/api";
import { runComposioPreflight } from "@/integrations/composio/preflight";
import { requirePoc } from "../_guard";

/** Preflight : état / configuration uniquement (présence des variables, jamais leur valeur). Authentifié, POC activé. */
export const GET = route(async (_req, _ctx, sessionUser) => {
  requirePoc();
  currentUser(sessionUser);
  return ok(runComposioPreflight());
});
