import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { retryAction } from "@/actions/engine";

/**
 * Nouvelle tentative d'une action FAILED (déjà validée).
 * Si le dernier échec est un envoi au résultat inconnu, EMA vérifie d'abord les
 * éléments envoyés. `force: true` n'est accepté qu'après vérification humaine
 * explicite depuis l'interface.
 */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req
    .clone()
    .json()
    .then(() => parseBody(req, z.object({ force: z.boolean().default(false) })))
    .catch(() => ({ force: false }));
  return ok(await retryAction(id, "user", { force: body.force }));
});
