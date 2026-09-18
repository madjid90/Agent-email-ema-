import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { refreshComposioConnection } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

/**
 * Retour du parcours OAuth hébergé par Composio. Rien n'est lu dans l'URL de
 * retour : l'état est relu chez Composio pour l'utilisateur de la session.
 * Sans session (autre navigateur), l'utilisateur se reconnecte puis rafraîchit.
 */
export const GET = route(
  async (_req, _ctx, sessionUser) => {
    requirePoc();
    const base = getEnv().APP_URL.replace(/\/+$/, "");
    if (!sessionUser) return NextResponse.redirect(`${base}/login`, { status: 302 });
    try {
      const state = await refreshComposioConnection(sessionUser);
      return NextResponse.redirect(`${base}/poc/composio?returned=1&status=${encodeURIComponent(state.status)}`, { status: 302 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur";
      return NextResponse.redirect(`${base}/poc/composio?error=${encodeURIComponent(message.slice(0, 200))}`, { status: 302 });
    }
  },
  { public: true },
);
