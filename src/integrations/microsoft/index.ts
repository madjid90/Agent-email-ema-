import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { getConfiguredIntegrations } from "@/lib/env";
import { getConnectionInfo } from "@/database/repositories/connections";
import { createConnectedGraphClient } from "./graph-client";
import { getMe } from "./mail";
import { getSyncState, type SyncState } from "./sync";
import { TOKEN_PROVIDER } from "./token-store";

export { GRAPH_SCOPES, buildAuthorizeUrl, createOAuthState, consumeOAuthState, completeConnection, disconnect } from "./oauth";
export { GraphClient, GraphError, createConnectedGraphClient, isOutlookConnected } from "./graph-client";
export { syncInbox, importConversation, getSyncState } from "./sync";
export * as mail from "./mail";
export * as attachments from "./attachments";
export type { OutlookSyncResult } from "./types";

export interface OutlookStatus extends SyncState {
  configured: boolean;
  connected: boolean;
  /** `revoked` : Microsoft a refusé le rafraîchissement, l'utilisateur doit reconnecter. */
  status: "active" | "revoked" | "disconnected";
  accountEmail: string | null;
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string | null;
}

/** État de la connexion Outlook d'un utilisateur (`userId` absent : unique connexion de l'instance). */
export function getOutlookStatus(db: Db = getDb(), userId?: string | null): OutlookStatus {
  const configured = getConfiguredIntegrations().microsoft;
  const info = getConnectionInfo(TOKEN_PROVIDER, userId, db);
  return {
    configured,
    connected: Boolean(info) && info?.status === "active",
    status: info ? info.status : "disconnected",
    accountEmail: info?.accountEmail ?? null,
    scopes: info ? info.scopes.split(" ").filter(Boolean) : [],
    expiresAt: info?.expiresAt ?? null,
    connectedAt: info?.updatedAt ?? null,
    ...getSyncState(db, userId ?? null),
  };
}

/** Test réel : GET /me avec le token stocké (rafraîchi si nécessaire). */
export async function testOutlookConnection(db: Db = getDb(), userId?: string | null): Promise<{ ok: boolean; message: string }> {
  const status = getOutlookStatus(db, userId);
  if (!status.configured) return { ok: false, message: "Variables MICROSOFT_* non renseignées" };
  if (status.status === "revoked") return { ok: false, message: "Connexion Microsoft expirée ou révoquée : reconnecter Outlook" };
  if (!status.connected) return { ok: false, message: "Outlook non connecté (Paramètres → Connexions)" };
  try {
    const me = await getMe(createConnectedGraphClient({ db, userId }));
    return { ok: true, message: `Connecté : ${me.email ?? "adresse inconnue"}${status.lastSyncAt ? ` · dernière synchronisation ${status.lastSyncAt}` : ""}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Erreur Graph" };
  }
}
