import Database from "better-sqlite3";
import path from "node:path";
import { databasePath, ensureDir } from "@/lib/paths";
import { createLogger } from "@/lib/logger";
import { runMigrations } from "./migrate";

const log = createLogger("db");

type Db = Database.Database;

// Singleton par process (Next.js et worker ont chacun le leur).
const globalRef = globalThis as unknown as { __emaDb?: Db };

export function getDb(): Db {
  if (globalRef.__emaDb) return globalRef.__emaDb;
  const file = databasePath();
  if (file !== ":memory:") ensureDir(path.dirname(file));
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  globalRef.__emaDb = db;
  log.debug("database opened", { file: file === ":memory:" ? file : path.basename(file) });
  return db;
}

/** Ferme et oublie la connexion (tests, arrêt propre du worker). */
export function closeDb(): void {
  if (globalRef.__emaDb) {
    globalRef.__emaDb.close();
    delete globalRef.__emaDb;
  }
}

/** Ouvre une base isolée (tests). */
export function openIsolatedDb(file = ":memory:"): Db {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export type { Db };
