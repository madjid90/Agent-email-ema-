import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { completeConnection, GraphClient } from "@/integrations/microsoft";
import { getMe } from "@/integrations/microsoft/mail";

/**
 * Retour Microsoft. L'utilisateur destinataire des tokens est celui mémorisé
 * dans l'état anti-CSRF au départ du flux — ni un cookie ni un paramètre libre.
 * Route publique : le navigateur revient de login.microsoftonline.com.
 */
const RETURN_PATH = "/parametres/connexions";

export const GET = route(
  async (req) => {
    const url = new URL(req.url);
    const appUrl = getEnv().APP_URL;
    const error = url.searchParams.get("error");
    if (error) {
      const desc = url.searchParams.get("error_description") ?? error;
      return NextResponse.redirect(`${appUrl}${RETURN_PATH}?error=${encodeURIComponent(desc.slice(0, 200))}`, { status: 302 });
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new EmaError("VALIDATION", "Paramètres OAuth manquants");
    try {
      await completeConnection({ code, state }, async (accessToken) => getMe(new GraphClient({ getAccessToken: async () => accessToken })));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de connexion";
      return NextResponse.redirect(`${appUrl}${RETURN_PATH}?error=${encodeURIComponent(message.slice(0, 200))}`, { status: 302 });
    }
    return NextResponse.redirect(`${appUrl}${RETURN_PATH}?connected=1`, { status: 302 });
  },
  { public: true },
);
