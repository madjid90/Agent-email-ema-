import type { Db } from "../connection";
import { getDb } from "../connection";

/**
 * Verrou simple en SQLite pour éviter deux exécutions concurrentes d'une tâche
 * du worker (ou worker + route API). Retourne true si le verrou est acquis.
 */
export function acquireLock(name: string, owner: string, ttlSeconds: number, db: Db = getDb()): boolean {
  const now = new Date();
  const until = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const res = db
    .prepare(
      `INSERT INTO worker_locks (name, owner, locked_until) VALUES (@name, @owner, @until)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, locked_until = excluded.locked_until
       WHERE worker_locks.locked_until <= @now OR worker_locks.owner = excluded.owner`,
    )
    .run({ name, owner, until, now: now.toISOString() });
  return res.changes === 1;
}

export function releaseLock(name: string, owner: string, db: Db = getDb()): void {
  db.prepare("DELETE FROM worker_locks WHERE name = ? AND owner = ?").run(name, owner);
}
