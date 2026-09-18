import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { completeComposioCallback, refreshComposioConnection, resolveCallbackMode } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

const log = createLogger("composio.callback");

/**
 * Retour du parcours OAuth hébergé par Composio. Le mode est EXPLICITE :
 *
 * - `verified` (verifier URL du projet Composio = cette route) : `session_uri`
 *   obligatoire, consommé côté serveur avec l'utilisateur de la session EMA
 *   (`complete_auth`) ; sans `session_uri`, refus propre, aucun appel.
 * - `local` (hors production uniquement) : `complete_auth` n'est JAMAIS appelé,
 *   l'état est simplement relu chez Composio ; un `session_uri` inattendu
 *   signale une incohérence de configuration (verifier URL actif côté Composio
 *   alors que COMPOSIO_CALLBACK_VERIFICATION=false) et n'est pas consommé.
 *
 * Sans session EMA (autre navigateur, cookie perdu), rien n'est consommé.
 */
export const GET = route(
  async (req, _ctx, sessionUser) => {
    requirePoc();
    const base = getEnv().APP_URL.replace(/\/+$/, "");
    const sessionUri = new URL(req.url).searchParams.get("session_uri");
    const back = (params: Record<string, string>) => NextResponse.redirect(`${base}/poc/composio?${new URLSearchParams(params).toString()}`, { status: 302 });
    if (!sessionUser) return NextResponse.redirect(`${base}/login?error=${encodeURIComponent("Session EMA absente : reconnectez-vous puis relancez la connexion Outlook via Composio.")}`, { status: 302 });
    try {
      const mode = resolveCallbackMode();
      if (mode === "verified") {
        if (!sessionUri) {
          log.warn("verified callback without session_uri", { userId: sessionUser.id });
          return back({ error: "Retour OAuth invalide : session_uri absent (verifier URL Composio mal configuré ?). Relancez la connexion." });
        }
        const state = await completeComposioCallback(sessionUser, sessionUri);
        return back({ returned: "1", status: state.status });
      }
      // Mode local : jamais de complete_auth.
      if (sessionUri) {
        log.warn("session_uri received in local callback mode: not consumed (configuration mismatch: verifier URL set in Composio but COMPOSIO_CALLBACK_VERIFICATION=false)", { userId: sessionUser.id });
        return back({ error: "Incohérence de configuration : un session_uri a été reçu alors que COMPOSIO_CALLBACK_VERIFICATION=false. Activez la vérification (recommandé) ou retirez le verifier URL côté Composio. Rien n'a été consommé." });
      }
      const state = await refreshComposioConnection(sessionUser);
      return back({ returned: "1", status: state.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur";
      return back({ error: message.slice(0, 200) });
    }
  },
  { public: true },
);
