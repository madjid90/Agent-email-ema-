import { getEnv, getConfiguredIntegrations } from "@/lib/env";
import { getTokenInfo } from "@/database/repositories/tokens";
import { NotImplementedError } from "@/lib/errors";

/**
 * Intégration Microsoft Graph (phase 1). Cette couche est la seule à lire
 * MICROSOFT_* et les tokens chiffrés. Aucune fonction ne renvoie de token.
 */
export const GRAPH_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"] as const;
export const TOKEN_PROVIDER = "microsoft";

export interface OutlookStatus {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  scopes: string[];
  expiresAt: string | null;
}

export function getOutlookStatus(): OutlookStatus {
  const configured = getConfiguredIntegrations().microsoft;
  const info = getTokenInfo(TOKEN_PROVIDER);
  return {
    configured,
    connected: Boolean(info),
    accountEmail: info?.accountEmail ?? null,
    scopes: info ? info.scopes.split(" ").filter(Boolean) : [],
    expiresAt: info?.expiresAt ?? null,
  };
}

/** URL d'autorisation OAuth (authorization code). Implémentation complète en phase 1. */
export function buildAuthorizeUrl(state: string): string {
  const env = getEnv();
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_REDIRECT_URI) throw new NotImplementedError("Connexion Outlook (variables MICROSOFT_* manquantes)", "phase 1");
  const params = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.MICROSOFT_REDIRECT_URI,
    response_mode: "query",
    scope: GRAPH_SCOPES.join(" "),
    state,
  });
  return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function testOutlookConnection(): Promise<{ ok: boolean; message: string }> {
  const status = getOutlookStatus();
  if (!status.configured) return { ok: false, message: "Variables MICROSOFT_* non renseignées" };
  if (!status.connected) return { ok: false, message: "Outlook non connecté (étape Outlook du setup)" };
  return { ok: false, message: "Appel Graph : phase 1" };
}
