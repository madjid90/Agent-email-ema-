import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { completeComposioCallback, refreshComposioConnection, resolveCallbackMode } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

/**
 * Retour du parcours OAuth hébergé par Composio.
 *
 * Mode `verified` (verifier URL du projet Composio = cette route) : Composio
 * ajoute un `session_uri` à usage unique. Il est consommé côté serveur avec
 * l'utilisateur de la session EMA (`complete_auth`) ; la connexion n'est
 * activée que si c'est bien lui qui a démarré le parcours.
 *
 * Mode `local` (hors production uniquement) : aucun paramètre n'est lu ; l'état
 * est simplement relu chez Composio pour l'utilisateur de session.
 *
 * Sans session (autre navigateur, cookie perdu), rien n'est consommé : l'utilisateur
 * se reconnecte à EMA puis relance la connexion depuis la page POC.
 */
export const GET = route(
  async (req, _ctx, sessionUser) => {
    requirePoc();
    const base = getEnv().APP_URL.replace(/\/+$/, "");
    const sessionUri = new URL(req.url).searchParams.get("session_uri");
    if (!sessionUser) return NextResponse.redirect(`${base}/login?error=${encodeURIComponent("Session EMA absente : reconnectez-vous puis relancez la connexion Outlook via Composio.")}`, { status: 302 });
    try {
      const mode = resolveCallbackMode();
      const state = mode === "verified" || sessionUri ? await completeComposioCallback(sessionUser, sessionUri ?? "") : await refreshComposioConnection(sessionUser);
      return NextResponse.redirect(`${base}/poc/composio?returned=1&status=${encodeURIComponent(state.status)}`, { status: 302 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur";
      return NextResponse.redirect(`${base}/poc/composio?error=${encodeURIComponent(message.slice(0, 200))}`, { status: 302 });
    }
  },
  { public: true },
);
