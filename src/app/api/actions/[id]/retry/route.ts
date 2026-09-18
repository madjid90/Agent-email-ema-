import { z } from "zod";
import { route, ok, parseBody, currentUser, ownedOr404 } from "@/lib/api";
import { retryAction } from "@/actions/engine";
import { getAction } from "@/database/repositories/actions";

/**
 * Nouvelle tentative d'une action FAILED (déjà validée).
 * Si le dernier échec est un envoi au résultat inconnu, EMA vérifie d'abord les
 * éléments envoyés. `force: true` n'est accepté qu'après vérification humaine
 * explicite depuis l'interface.
 */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  ownedOr404(getAction(id), currentUser(sessionUser), `Action ${id}`);
  const body = await req
    .clone()
    .json()
    .then(() => parseBody(req, z.object({ force: z.boolean().default(false) })))
    .catch(() => ({ force: false }));
  return ok(await retryAction(id, "user", { force: body.force }));
});
