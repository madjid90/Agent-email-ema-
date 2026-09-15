import type { Db } from "../connection";
import { getDb } from "../connection";
import { nowIso } from "@/lib/ids";

export function kvGet(key: string, db: Db = getDb()): string | null {
  const row = db.prepare("SELECT value FROM settings_kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string, db: Db = getDb()): void {
  db.prepare(
    `INSERT INTO settings_kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function kvGetJson<T>(key: string, fallback: T, db: Db = getDb()): T {
  const raw = kvGet(key, db);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function kvSetJson(key: string, value: unknown, db: Db = getDb()): void {
  kvSet(key, JSON.stringify(value), db);
}
