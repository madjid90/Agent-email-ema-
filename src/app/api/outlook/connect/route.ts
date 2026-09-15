import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { route } from "@/lib/api";
import { buildAuthorizeUrl } from "@/integrations/microsoft";
import { kvSet } from "@/database/repositories/kv";

/** Démarre le flux OAuth Microsoft (le callback est implémenté en phase 1). */
export const GET = route(async () => {
  const state = randomBytes(16).toString("hex");
  kvSet("outlook.oauth_state", state);
  return NextResponse.redirect(buildAuthorizeUrl(state), { status: 302 });
});
