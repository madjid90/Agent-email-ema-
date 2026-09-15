import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as emailsRepo from "@/database/repositories/emails";
import { kvGet, kvSet, kvGetJson, kvSetJson } from "@/database/repositories/kv";
import { logHistory } from "@/database/repositories/history";
import type { EmailRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import { ingestEmailAttachments } from "./attachments";
import type { GraphClient } from "./graph-client";
import { fetchInboxDeltaPage, listConversation, toNewEmail } from "./mail";
import { loadTokenSet } from "./token-store";
import type { GraphMessage, OutlookSyncResult } from "./types";

const log = createLogger("microsoft.sync");

export const KV = {
  cursor: "outlook.sync_cursor",
  lastSyncAt: "outlook.last_sync_at",
  lastSyncResult: "outlook.last_sync_result",
  lastSyncError: "outlook.last_sync_error",
  lastEmailAt: "outlook.last_email_at",
} as const;

export interface SyncOptions {
  db?: Db;
  /** Nombre maximal de nouveaux emails ingérés par passage. */
  limit?: number;
  /** Première synchronisation : ne remonter que les N derniers jours (0 = tout). */
  initialSyncDays?: number;
  maxAttachmentBytes?: number;
  /** Téléchargement des pièces jointes pendant la synchronisation. */
  withAttachments?: boolean;
  now?: () => Date;
}

/**
 * Synchronise la boîte de réception vers SQLite via delta query.
 * - jamais deux fois le même email (graph_id unique, vérification préalable) ;
 * - curseur (nextLink/deltaLink) conservé dans settings_kv ;
 * - une page est toujours traitée en entier ; la limite borne le nombre de pages ;
 * - aucun email n'est modifié, déplacé ou supprimé côté Outlook.
 */
export async function syncInbox(client: GraphClient, opts: SyncOptions = {}): Promise<OutlookSyncResult> {
  const db = opts.db ?? getDb();
  const env = getEnv();
  const limit = opts.limit ?? env.EMAIL_SYNC_LIMIT;
  const initialDays = opts.initialSyncDays ?? env.EMAIL_INITIAL_SYNC_DAYS;
  const maxBytes = opts.maxAttachmentBytes ?? Math.round(env.ATTACHMENT_MAX_MB * 1024 * 1024);
  const withAttachments = opts.withAttachments ?? true;
  const now = opts.now ?? (() => new Date());
  const accountEmail = loadTokenSet(db)?.accountEmail ?? null;

  const result: OutlookSyncResult = { inserted: 0, updated: 0, skipped: 0, attachments: 0, pages: 0, reachedLimit: false, lastEmailAt: kvGet(KV.lastEmailAt, db), errors: [] };
  let cursor = kvGet(KV.cursor, db) || null;
  const initialSince = !cursor && initialDays > 0 ? new Date(now().getTime() - initialDays * 86_400_000).toISOString() : null;
  const pageSize = Math.max(1, Math.min(limit, 50));

  try {
    for (;;) {
      const page = await fetchInboxDeltaPage(client, cursor, { initialSince, pageSize });
      result.pages++;
      for (const m of page.messages) {
        if (m.isDraft) {
          result.skipped++;
          continue;
        }
        const existing = emailsRepo.getEmailByGraphId(m.id, db);
        if (existing) {
          if ((existing.is_read === 1) !== Boolean(m.isRead)) {
            emailsRepo.touchEmail(existing.id, { isRead: Boolean(m.isRead) }, db);
            result.updated++;
          } else {
            result.skipped++;
          }
          continue;
        }
        const row = emailsRepo.insertEmail(toNewEmail(m, { accountEmail, status: "NEW", direction: "inbound" }), db);
        result.inserted++;
        if (!result.lastEmailAt || row.received_at > result.lastEmailAt) result.lastEmailAt = row.received_at;
        if (withAttachments && row.has_attachments === 1) {
          try {
            const ingest = await ingestEmailAttachments(client, row, maxBytes, db);
            result.attachments += ingest.stored.length;
          } catch (err) {
            result.errors.push(`pièces jointes ${row.id} : ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      const next = page.nextLink ?? page.deltaLink;
      if (next) {
        cursor = next;
        kvSet(KV.cursor, next, db);
      }
      if (page.deltaLink) break; // fin du delta : le prochain passage repartira du deltaLink
      if (!page.nextLink) break;
      if (result.inserted >= limit) {
        result.reachedLimit = true;
        break;
      }
    }
    kvSet(KV.lastSyncError, "", db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    kvSet(KV.lastSyncError, message, db);
    log.error("sync failed", { message, pages: result.pages, inserted: result.inserted });
  }

  kvSet(KV.lastSyncAt, nowIso(), db);
  if (result.lastEmailAt) kvSet(KV.lastEmailAt, result.lastEmailAt, db);
  kvSetJson(KV.lastSyncResult, result, db);
  if (result.inserted > 0) {
    logHistory({ eventType: "outlook.sync", message: `${result.inserted} nouvel(s) email(s) synchronisé(s)${result.attachments ? `, ${result.attachments} pièce(s) jointe(s)` : ""}`, actor: "worker", details: { pages: result.pages, reachedLimit: result.reachedLimit } }, db);
  }
  return result;
}

export interface SyncState {
  lastSyncAt: string | null;
  lastEmailAt: string | null;
  lastSyncError: string | null;
  lastResult: OutlookSyncResult | null;
  hasCursor: boolean;
}

export function getSyncState(db: Db = getDb()): SyncState {
  return {
    lastSyncAt: kvGet(KV.lastSyncAt, db) || null,
    lastEmailAt: kvGet(KV.lastEmailAt, db) || null,
    lastSyncError: kvGet(KV.lastSyncError, db) || null,
    lastResult: kvGetJson<OutlookSyncResult | null>(KV.lastSyncResult, null, db),
    hasCursor: Boolean(kvGet(KV.cursor, db)),
  };
}

/**
 * Importe une conversation depuis Graph : les messages inconnus sont enregistrés
 * avec le statut CONTEXT (jamais traités comme nouveaux). Renvoie le thread
 * complet trié, borné à `max` messages.
 */
export async function importConversation(client: GraphClient, conversationId: string, opts: { db?: Db; max?: number } = {}): Promise<EmailRow[]> {
  const db = opts.db ?? getDb();
  const max = opts.max ?? 30;
  const accountEmail = loadTokenSet(db)?.accountEmail ?? null;
  const messages = await listConversation(client, conversationId, max);
  for (const m of messages) upsertContextMessage(m, accountEmail, db);
  return emailsRepo.listThread(conversationId, db).slice(-max);
}

/** Enregistre un message Graph comme contexte s'il est inconnu ; renvoie la ligne. */
export function upsertContextMessage(m: GraphMessage, accountEmail: string | null, db: Db = getDb()): EmailRow {
  const existing = emailsRepo.getEmailByGraphId(m.id, db);
  if (existing) return existing;
  if (m.internetMessageId) {
    const byInternet = emailsRepo.getEmailByInternetMessageId(m.internetMessageId, db);
    if (byInternet) return byInternet;
  }
  return emailsRepo.insertEmail(toNewEmail(m, { accountEmail, status: "CONTEXT" }), db);
}
