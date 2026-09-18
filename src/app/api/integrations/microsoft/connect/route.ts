import { NextResponse } from "next/server";
import { route, currentUser } from "@/lib/api";
import { buildAuthorizeUrl, createOAuthState } from "@/integrations/microsoft";

/** Démarre le flux OAuth Microsoft pour LE compte connecté (authorization code, jamais de mot de passe). */
export const GET = route(async (_req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const state = createOAuthState({ userId: user.id });
  return NextResponse.redirect(buildAuthorizeUrl(state), { status: 302 });
});
