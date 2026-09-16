import { describe, it, expect, beforeEach } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import { migrationStatus } from "@/database/migrate";
import * as emails from "@/database/repositories/emails";
import * as followups from "@/database/repositories/followups";
import * as history from "@/database/repositories/history";
import * as locks from "@/database/repositories/locks";
import * as kv from "@/database/repositories/kv";

describe("SQLite", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });

  it("applique toutes les migrations", () => {
    const status = migrationStatus(db);
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((s) => s.applied)).toBe(true);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["emails", "email_analyses", "actions", "approvals", "scheduled_followups", "documents", "history", "oauth_tokens", "worker_locks", "settings_kv", "chat_messages"]) {
      expect(tables).toContain(t);
    }
  });

  it("insère et retrouve un email, refuse les doublons graph_id", () => {
    const e = emails.insertEmail({ graphId: "g1", threadId: "t1", senderEmail: "a@b.fr", subject: "Test", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    expect(e.status).toBe("NEW");
    expect(emails.getEmailByGraphId("g1", db)?.id).toBe(e.id);
    expect(() => emails.insertEmail({ graphId: "g1", subject: "Dup", receivedAt: "2026-09-15T10:00:00.000Z" }, db)).toThrow();
    emails.updateEmailStatus(e.id, "PROCESSED", db);
    expect(emails.getEmail(e.id, db)?.status).toBe("PROCESSED");
  });

  it("liste un thread dans l'ordre chronologique", () => {
    emails.insertEmail({ graphId: "g2", threadId: "t", subject: "2", receivedAt: "2026-09-15T12:00:00.000Z" }, db);
    emails.insertEmail({ graphId: "g3", threadId: "t", subject: "1", receivedAt: "2026-09-15T11:00:00.000Z" }, db);
    expect(emails.listThread("t", db).map((e) => e.subject)).toEqual(["1", "2"]);
  });

  it("gère les relances : dues, annulation, report", () => {
    const f = followups.insertFollowup({ threadId: "t", reason: "Devis sans réponse", executeAt: "2020-01-01T00:00:00.000Z" }, db);
    expect(followups.listDueFollowups("2026-01-01T00:00:00.000Z", db).map((x) => x.id)).toEqual([f.id]);
    expect(followups.rescheduleFollowup(f.id, "2030-01-01T00:00:00.000Z", db)).toBe(true);
    expect(followups.listDueFollowups("2026-01-01T00:00:00.000Z", db)).toHaveLength(0);
    expect(followups.cancelFollowup(f.id, "Test", db)).toBe(true);
    expect(followups.cancelFollowup(f.id, "Test", db)).toBe(false);
    expect(followups.getFollowup(f.id, db)?.status).toBe("CANCELLED");
  });

  it("journalise l'historique", () => {
    history.logHistory({ eventType: "test", message: "hello", details: { a: 1 } }, db);
    const rows = history.listHistory({}, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toBe('{"a":1}');
  });

  it("verrous : un seul propriétaire à la fois, expiration", () => {
    expect(locks.acquireLock("scan", "w1", 60, db)).toBe(true);
    expect(locks.acquireLock("scan", "w2", 60, db)).toBe(false);
    // Phase 8A : plus de ré-entrance, même pour le propriétaire (un tick ne peut
    // pas relancer une exécution encore en cours).
    expect(locks.acquireLock("scan", "w1", 60, db)).toBe(false);
    expect(locks.renewLock("scan", "w1", 120, db)).toBe(true);
    expect(locks.renewLock("scan", "w2", 120, db)).toBe(false);
    locks.releaseLock("scan", "w2", db); // pas le propriétaire : sans effet
    expect(locks.currentLock("scan", db)?.owner).toBe("w1");
    locks.releaseLock("scan", "w1", db);
    expect(locks.acquireLock("scan", "w2", 60, db)).toBe(true);
    db.prepare("UPDATE worker_locks SET locked_until = '2000-01-01T00:00:00.000Z'").run();
    expect(locks.acquireLock("scan", "w3", 60, db)).toBe(true);
  });

  it("stocke des clés/valeurs", () => {
    kv.kvSetJson("x", { ok: true }, db);
    expect(kv.kvGetJson("x", null, db)).toEqual({ ok: true });
    expect(kv.kvGet("absent", db)).toBeNull();
  });
});
