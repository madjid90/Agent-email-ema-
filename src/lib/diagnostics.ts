import fs from "node:fs";
import path from "node:path";
import { getDb, type Db } from "@/database/connection";
import { migrationStatus } from "@/database/migrate";
import { kvGet } from "@/database/repositories/kv";
import { llmUsageByDay, llmUsageByOperation, llmUsageSince } from "@/database/repositories/llm-runs";
import { countActions } from "@/database/repositories/actions";
import { listFollowups } from "@/database/repositories/followups";
import { getCompanies, getSettings } from "./config";
import { assetStatus } from "@/documents/assets";
import { checkEnv, getConfiguredIntegrations, getEnv } from "./env";
import { databasePath, inspectPermissions, privateRoot, PRIVATE_DIRS, resolveFromRoot } from "./paths";
import { isOutlookConnected } from "@/integrations/microsoft/graph-client";
import { startOfTodayIso } from "./time";

/**
 * Diagnostic d'exploitation (phase 8) : aucune donnée client, aucun secret.
 * Utilisé par `/api/health`, la page Paramètres et `npm run doctor`.
 */
export type CheckLevel = "PASS" | "WARN" | "FAIL";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

/** Seuil d'alerte sur l'espace disque libre. */
export const DISK_WARN_RATIO = 0.1;
export const DISK_FAIL_RATIO = 0.03;
/** Battement du worker considéré perdu au-delà de ce délai. */
export const WORKER_STALE_MINUTES = 15;

function dirSize(dir: string, budget = { files: 0 }): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.files++ > 20_000) break;
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(full, budget);
      else total += fs.statSync(full).size;
    } catch {
      /* fichier supprimé entre-temps */
    }
  }
  return total;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  freeRatio: number;
  databaseBytes: number;
  privateBytes: number;
  backupsBytes: number;
}

export function diskUsage(): DiskUsage {
  const db = databasePath();
  let totalBytes = 0;
  let freeBytes = 0;
  try {
    const st = fs.statfsSync(resolveFromRoot("."));
    totalBytes = st.blocks * st.bsize;
    freeBytes = st.bavail * st.bsize;
  } catch {
    /* statfs indisponible : valeurs à zéro, signalées comme inconnues */
  }
  const databaseBytes = db === ":memory:" ? 0 : ["", "-wal", "-shm"].reduce((sum, suffix) => sum + (fs.existsSync(`${db}${suffix}`) ? fs.statSync(`${db}${suffix}`).size : 0), 0);
  return {
    totalBytes,
    freeBytes,
    freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 1,
    databaseBytes,
    privateBytes: PRIVATE_DIRS.reduce((sum, d) => sum + dirSize(path.join(privateRoot(), d)), 0),
    backupsBytes: dirSize(resolveFromRoot("backups")),
  };
}

export interface SqliteHealth {
  integrity: "ok" | "failed" | "unknown";
  journalMode: string;
  foreignKeys: boolean;
  pendingMigrations: string[];
}

export function sqliteHealth(database?: Db): SqliteHealth {
  try {
    const db = database ?? getDb();
    const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined)?.integrity_check ?? "unknown";
    const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode ?? "unknown";
    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys === 1;
    const pending = migrationStatus(db).filter((m) => !m.applied).map((m) => m.name);
    return { integrity: integrity === "ok" ? "ok" : "failed", journalMode: journal, foreignKeys: fk, pendingMigrations: pending };
  } catch {
    return { integrity: "unknown", journalMode: "unknown", foreignKeys: false, pendingMigrations: [] };
  }
}

export interface WorkerHealth {
  lastHeartbeatAt: string | null;
  minutesSince: number | null;
  running: boolean;
}

export function workerHealth(now: Date = new Date(), db?: Db): WorkerHealth {
  const beat = kvGet("worker.heartbeat_at", db ?? getDb());
  if (!beat) return { lastHeartbeatAt: null, minutesSince: null, running: false };
  const minutes = (now.getTime() - new Date(beat).getTime()) / 60_000;
  return { lastHeartbeatAt: beat, minutesSince: Math.round(minutes), running: minutes <= WORKER_STALE_MINUTES };
}

export interface CostReport {
  today: { runs: number; errors: number; inputTokens: number; outputTokens: number; estimatedCost: number };
  currency: string;
  byDay: ReturnType<typeof llmUsageByDay>;
  byOperation: ReturnType<typeof llmUsageByOperation>;
}

export function costReport(days = 14, db?: Db): CostReport {
  const settings = getSettings();
  const since = startOfTodayIso();
  const database = db ?? getDb();
  const today = llmUsageSince(since, database);
  const estimatedCost = (today.inputTokens / 1_000_000) * settings.costs.inputPerMillion + (today.outputTokens / 1_000_000) * settings.costs.outputPerMillion;
  return {
    today: { ...today, estimatedCost: Math.round(estimatedCost * 10_000) / 10_000 },
    currency: settings.costs.currency,
    byDay: llmUsageByDay(days, database),
    byOperation: llmUsageByOperation(since, database),
  };
}

export interface HealthReport {
  status: CheckLevel;
  version: string;
  time: string;
  checks: Check[];
  disk: DiskUsage;
  sqlite: SqliteHealth;
  worker: WorkerHealth;
}

/** Ensemble des contrôles. Aucun secret n'est renvoyé, seulement leur présence. */
export function runChecks(version: string, now: Date = new Date(), db?: Db): HealthReport {
  const checks: Check[] = [];
  const env = getEnv();
  const database = db ?? getDb();

  // Configuration
  const issues = checkEnv(env);
  const blocking = issues.filter((i) => i.level === "error");
  checks.push({
    name: "configuration",
    level: blocking.length ? "FAIL" : issues.length ? "WARN" : "PASS",
    detail: blocking.length ? blocking.map((i) => i.variable).join(", ") : issues.length ? `optionnel : ${issues.map((i) => i.variable).join(", ")}` : "toutes les variables requises sont présentes",
  });

  // Base de données
  const sqlite = sqliteHealth(database);
  checks.push({
    name: "base de données",
    level: sqlite.integrity === "ok" && sqlite.pendingMigrations.length === 0 ? "PASS" : sqlite.integrity === "failed" ? "FAIL" : "WARN",
    detail: `intégrité : ${sqlite.integrity}, journal : ${sqlite.journalMode}${sqlite.pendingMigrations.length ? `, migrations en attente : ${sqlite.pendingMigrations.join(", ")}` : ""}`,
  });

  // Worker
  const worker = workerHealth(now, database);
  checks.push({
    name: "worker",
    level: worker.running ? "PASS" : worker.lastHeartbeatAt ? "WARN" : "WARN",
    detail: worker.lastHeartbeatAt ? `dernier battement il y a ${worker.minutesSince} min` : "aucun battement enregistré (worker jamais démarré ?)",
  });

  // Disque
  const disk = diskUsage();
  checks.push({
    name: "espace disque",
    level: disk.totalBytes === 0 ? "WARN" : disk.freeRatio < DISK_FAIL_RATIO ? "FAIL" : disk.freeRatio < DISK_WARN_RATIO ? "WARN" : "PASS",
    detail: disk.totalBytes === 0 ? "espace disque inconnu" : `${Math.round(disk.freeRatio * 100)} % libre · base ${mb(disk.databaseBytes)} · private ${mb(disk.privateBytes)} · sauvegardes ${mb(disk.backupsBytes)}`,
  });

  // Droits des fichiers sensibles
  const perms = inspectPermissions().filter((p) => p.exists);
  const exposed = perms.filter((p) => p.worldReadable);
  checks.push({
    name: "permissions",
    level: exposed.length ? "WARN" : "PASS",
    detail: exposed.length ? `accessible au-delà du propriétaire : ${exposed.map((p) => `${path.basename(p.path)} (${p.mode})`).join(", ")}` : `${perms.length} chemin(s) en droits propriétaire uniquement`,
  });

  // Intégrations
  const integrations = getConfiguredIntegrations();
  checks.push({ name: "Anthropic", level: integrations.anthropic ? "PASS" : "WARN", detail: integrations.anthropic ? `clé présente, modèle ${env.ANTHROPIC_MODEL}` : "ANTHROPIC_API_KEY absente" });
  let outlook = false;
  try {
    outlook = isOutlookConnected();
  } catch {
    outlook = false;
  }
  checks.push({ name: "Outlook", level: outlook ? "PASS" : "WARN", detail: outlook ? "mailbox connectée (token stocké)" : "aucune mailbox connectée — /setup" });
  checks.push({
    name: "WhatsApp",
    level: integrations.whatsapp ? "PASS" : "WARN",
    detail: integrations.whatsapp ? `configuré${env.WHATSAPP_APP_SECRET ? ", signature des webhooks vérifiée" : ", SANS vérification de signature"}` : "non configuré (validations depuis l'interface uniquement)",
  });

  // Sauvegardes : chiffrées ou non (le mot de passe lui-même n'est jamais affiché)
  const backupEncrypted = Boolean(env.BACKUP_ENCRYPTION_PASSWORD);
  checks.push({
    name: "sauvegardes",
    level: backupEncrypted ? "PASS" : env.NODE_ENV === "production" ? "FAIL" : "WARN",
    detail: backupEncrypted ? "chiffrement AES-256-GCM configuré" : "BACKUP_ENCRYPTION_PASSWORD absent : sauvegardes en clair (refusées en production)",
  });

  // Sociétés et assets de signature
  const companies = getCompanies();
  const withSignature = companies.filter((c) => assetStatus(c, "signature").available).length;
  checks.push({
    name: "sociétés",
    level: companies.length === 0 ? "WARN" : withSignature === 0 ? "WARN" : "PASS",
    detail: companies.length === 0 ? "aucune société configurée" : `${companies.length} société(s), ${withSignature} avec signature disponible`,
  });

  const status: CheckLevel = checks.some((c) => c.level === "FAIL") ? "FAIL" : checks.some((c) => c.level === "WARN") ? "WARN" : "PASS";
  return { status, version, time: now.toISOString(), checks, disk, sqlite, worker };
}

export function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

/** Compteurs d'activité affichés dans le diagnostic (aucune donnée nominative). */
export function activitySummary(db?: Db): { pendingActions: number; activeFollowups: number; notificationsPending: number } {
  const database = db ?? getDb();
  return {
    pendingActions: countActions({ status: "WAITING_APPROVAL" }, database),
    activeFollowups: listFollowups({ status: ["SCHEDULED", "CHECK_FAILED", "WAITING_APPROVAL", "REMINDED"], limit: 200 }, database).length,
    notificationsPending: listFollowups({ status: ["REMINDED", "MAX_ATTEMPTS_REACHED", "REVIEW_REQUIRED"], limit: 200 }, database).filter((f) => f.notification_pending === 1).length,
  };
}
