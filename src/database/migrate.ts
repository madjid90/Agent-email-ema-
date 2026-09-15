import type Database from "better-sqlite3";
import { migrations } from "./migrations";

export interface MigrationStatus {
  name: string;
  applied: boolean;
  appliedAt: string | null;
}

function ensureTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

export function runMigrations(db: Database.Database): string[] {
  ensureTable(db);
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const done: string[] = [];
  const insert = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.name, new Date().toISOString());
    })();
    done.push(m.name);
  }
  return done;
}

export function migrationStatus(db: Database.Database): MigrationStatus[] {
  ensureTable(db);
  const rows = db.prepare("SELECT name, applied_at FROM schema_migrations").all() as { name: string; applied_at: string }[];
  const map = new Map(rows.map((r) => [r.name, r.applied_at]));
  return migrations.map((m) => ({ name: m.name, applied: map.has(m.name), appliedAt: map.get(m.name) ?? null }));
}
