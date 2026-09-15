import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { getConfiguredIntegrations } from "@/lib/env";
import { getTokenInfo } from "@/database/repositories/tokens";
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
  accountEmail: string | null;
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string | null;
}

export function getOutlookStatus(db: Db = getDb()): OutlookStatus {
  const configured = getConfiguredIntegrations().microsoft;
  const info = getTokenInfo(TOKEN_PROVIDER, db);
  return {
    configured,
    connected: Boolean(info),
    accountEmail: info?.accountEmail ?? null,
    scopes: info ? info.scopes.split(" ").filter(Boolean) : [],
    expiresAt: info?.expiresAt ?? null,
    connectedAt: info?.updatedAt ?? null,
    ...getSyncState(db),
  };
}

/** Test réel : GET /me avec le token stocké (rafraîchi si nécessaire). */
export async function testOutlookConnection(db: Db = getDb()): Promise<{ ok: boolean; message: string }> {
  const status = getOutlookStatus(db);
  if (!status.configured) return { ok: false, message: "Variables MICROSOFT_* non renseignées" };
  if (!status.connected) return { ok: false, message: "Outlook non connecté (étape Outlook du setup)" };
  try {
    const me = await getMe(createConnectedGraphClient({ db }));
    return { ok: true, message: `Connecté : ${me.email ?? "adresse inconnue"}${status.lastSyncAt ? ` · dernière synchronisation ${status.lastSyncAt}` : ""}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Erreur Graph" };
  }
}
