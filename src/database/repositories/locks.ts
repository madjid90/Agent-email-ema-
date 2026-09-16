import type { Db } from "../connection";
import { getDb } from "../connection";
import { nowIso } from "@/lib/ids";

/**
 * Verrou SQLite d'exécution (phase 8A).
 *
 * Un verrou n'est accordé que si aucun n'existe ou si le précédent est
 * réellement expiré. Il n'est plus repris au motif que l'`owner` est identique :
 * l'owner est unique par exécution, donc une tâche encore en cours ne peut pas
 * se relancer elle-même au tick suivant.
 */
export function acquireLock(name: string, owner: string, ttlSeconds: number, db: Db = getDb()): boolean {
  const now = nowIso();
  const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const res = db
    .prepare(
      `INSERT INTO worker_locks (name, owner, locked_until) VALUES (@name, @owner, @until)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, locked_until = excluded.locked_until
       WHERE worker_locks.locked_until <= @now`,
    )
    .run({ name, owner, until, now });
  return res.changes === 1;
}

/** Prolonge un verrou détenu (tâche longue). Sans effet si le verrou a changé de main. */
export function renewLock(name: string, owner: string, ttlSeconds: number, db: Db = getDb()): boolean {
  const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return db.prepare("UPDATE worker_locks SET locked_until = ? WHERE name = ? AND owner = ?").run(until, name, owner).changes === 1;
}

export function releaseLock(name: string, owner: string, db: Db = getDb()): void {
  db.prepare("DELETE FROM worker_locks WHERE name = ? AND owner = ?").run(name, owner);
}

/** Verrou actuellement détenu (diagnostic). */
export function currentLock(name: string, db: Db = getDb()): { owner: string; locked_until: string } | null {
  return (db.prepare("SELECT owner, locked_until FROM worker_locks WHERE name = ?").get(name) as { owner: string; locked_until: string } | undefined) ?? null;
}
