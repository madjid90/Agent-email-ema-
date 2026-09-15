import type { Db } from "../connection";
import { getDb } from "../connection";
import type { WebhookEventRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

/**
 * Dédoublonnage des webhooks : un événement (provider, external_id) n'est
 * traité qu'une fois, même si Meta le rejoue. Retourne false si déjà vu.
 */
export function claimWebhookEvent(input: { provider: string; externalId: string; eventType: string; sender?: string | null }, db: Db = getDb()): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO webhook_events (id, provider, external_id, event_type, sender, received_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(newId("whk"), input.provider, input.externalId, input.eventType, input.sender ?? null, nowIso());
  return res.changes === 1;
}

export function setWebhookEventResult(provider: string, externalId: string, result: string, db: Db = getDb()): void {
  db.prepare("UPDATE webhook_events SET result = ? WHERE provider = ? AND external_id = ?").run(result.slice(0, 300), provider, externalId);
}

export function listWebhookEvents(limit = 50, db: Db = getDb()): WebhookEventRow[] {
  return db.prepare("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?").all(limit) as WebhookEventRow[];
}
