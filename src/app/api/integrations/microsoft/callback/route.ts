import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { completeConnection, GraphClient } from "@/integrations/microsoft";
import { getMe } from "@/integrations/microsoft/mail";

/** Retour Microsoft : vérifie l'état, échange le code, stocke les tokens chiffrés. */
export const GET = route(async (req) => {
  const url = new URL(req.url);
  const appUrl = getEnv().APP_URL;
  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    return NextResponse.redirect(`${appUrl}/setup?step=outlook&error=${encodeURIComponent(desc.slice(0, 200))}`, { status: 302 });
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new EmaError("VALIDATION", "Paramètres OAuth manquants");
  try {
    await completeConnection({ code, state }, async (accessToken) => getMe(new GraphClient({ getAccessToken: async () => accessToken })));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur de connexion";
    return NextResponse.redirect(`${appUrl}/setup?step=outlook&error=${encodeURIComponent(message.slice(0, 200))}`, { status: 302 });
  }
  return NextResponse.redirect(`${appUrl}/setup?step=outlook&connected=1`, { status: 302 });
});
