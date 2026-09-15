import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { buildAuthorizeUrl, createOAuthState } from "@/integrations/microsoft";

/** Démarre le flux OAuth Microsoft (authorization code). Jamais de mot de passe. */
export const GET = route(async () => {
  const state = createOAuthState();
  return NextResponse.redirect(buildAuthorizeUrl(state), { status: 302 });
});
