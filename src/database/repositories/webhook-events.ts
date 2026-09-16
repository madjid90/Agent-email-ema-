import type { Db } from "../connection";
import { getDb } from "../connection";
import type { WebhookEventRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

/**
 * Cycle de traitement d'un événement entrant (phase 8A).
 *
 * RECEIVED → PROCESSING → PROCESSED | FAILED
 *
 * Le claim est atomique : deux livraisons simultanées du même message Meta ne
 * peuvent pas être traitées en parallèle. Si le process meurt en PROCESSING, le
 * verrou expire et l'événement redevient reprenable — au lieu d'être perdu comme
 * « doublon déjà vu ».
 */
export const PROCESSING_TTL_SECONDS = 120;

export type ClaimOutcome =
  | { claimed: true; event: WebhookEventRow; resumed: boolean }
  | { claimed: false; reason: "already_processed" | "in_progress"; event: WebhookEventRow };

export interface ClaimInput {
  provider: string;
  externalId: string;
  eventType: string;
  sender?: string | null;
  ttlSeconds?: number;
}

/**
 * Prend la main sur un événement. `resumed = true` signale une reprise après
 * interruption : l'appelant doit vérifier ce qui a déjà pu être fait avant de
 * rejouer quoi que ce soit.
 */
export function claimWebhookEvent(input: ClaimInput, db: Db = getDb()): ClaimOutcome {
  const now = nowIso();
  const lockedUntil = new Date(Date.now() + (input.ttlSeconds ?? PROCESSING_TTL_SECONDS) * 1000).toISOString();
  const params = { id: newId("whk"), provider: input.provider, external_id: input.externalId, event_type: input.eventType, sender: input.sender ?? null, now, locked_until: lockedUntil };

  const inserted = db
    .prepare(
      `INSERT INTO webhook_events (id, provider, external_id, event_type, sender, received_at, status, attempts, started_at, locked_until)
       VALUES (@id, @provider, @external_id, @event_type, @sender, @now, 'PROCESSING', 1, @now, @locked_until)
       ON CONFLICT(provider, external_id) DO UPDATE SET
         status = 'PROCESSING',
         attempts = webhook_events.attempts + 1,
         started_at = @now,
         locked_until = @locked_until
       WHERE webhook_events.status IN ('RECEIVED', 'FAILED')
          OR (webhook_events.status = 'PROCESSING' AND COALESCE(webhook_events.locked_until, '') <= @now)`,
    )
    .run(params);

  const event = getWebhookEvent(input.provider, input.externalId, db) as WebhookEventRow;
  if (inserted.changes === 1) return { claimed: true, event, resumed: event.attempts > 1 };
  return { claimed: false, reason: event.status === "PROCESSED" ? "already_processed" : "in_progress", event };
}

export function getWebhookEvent(provider: string, externalId: string, db: Db = getDb()): WebhookEventRow | null {
  return (db.prepare("SELECT * FROM webhook_events WHERE provider = ? AND external_id = ?").get(provider, externalId) as WebhookEventRow | undefined) ?? null;
}

/** Fin de traitement : résultat métier + statut terminal. */
export function completeWebhookEvent(provider: string, externalId: string, result: string, db: Db = getDb()): void {
  db.prepare("UPDATE webhook_events SET status = 'PROCESSED', result = ?, processed_at = ?, locked_until = NULL WHERE provider = ? AND external_id = ?").run(result.slice(0, 300), nowIso(), provider, externalId);
}

/** Échec : l'événement reste reprenable (Meta rejoue, ou reprise par le worker). */
export function failWebhookEvent(provider: string, externalId: string, error: string, db: Db = getDb()): void {
  db.prepare("UPDATE webhook_events SET status = 'FAILED', last_error = ?, processed_at = ?, locked_until = NULL WHERE provider = ? AND external_id = ?").run(error.slice(0, 300), nowIso(), provider, externalId);
}

/** Compat phase 3 : enregistre le résultat sans changer le statut terminal. */
export function setWebhookEventResult(provider: string, externalId: string, result: string, db: Db = getDb()): void {
  completeWebhookEvent(provider, externalId, result, db);
}

/** Événements bloqués en PROCESSING dont le verrou a expiré (crash). */
export function listStaleWebhookEvents(limit = 20, db: Db = getDb()): WebhookEventRow[] {
  return db
    .prepare("SELECT * FROM webhook_events WHERE status = 'PROCESSING' AND COALESCE(locked_until, '') <= ? ORDER BY received_at ASC LIMIT ?")
    .all(nowIso(), limit) as WebhookEventRow[];
}

export function listWebhookEvents(limit = 50, db: Db = getDb()): WebhookEventRow[] {
  return db.prepare("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?").all(limit) as WebhookEventRow[];
}
