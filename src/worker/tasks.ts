import { expireApprovals } from "@/actions/engine";
import { recoverStaleActions } from "@/actions/recovery";
import { listStaleWebhookEvents, failWebhookEvent } from "@/database/repositories/webhook-events";
import { logHistory } from "@/database/repositories/history";
import { listFollowups } from "@/database/repositories/followups";
import { processDueFollowups, reconcileFollowups, notifyFollowup } from "@/followups/service";
import { getSettings } from "@/lib/config";
import { kvSet } from "@/database/repositories/kv";
import { getDb } from "@/database/connection";
import { createConnectedGraphClient, isOutlookConnected, syncInbox } from "@/integrations/microsoft";
import { analyzePendingEmails } from "@/agent/orchestrator";
import { notifyUnsentApprovals, isWhatsappConfigured } from "@/integrations/whatsapp";
import { analyzeDocument } from "@/documents/analyze";
import { listDocumentsPendingAnalysis } from "@/database/repositories/documents";
import { getConfiguredIntegrations } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import type { WorkerTask } from "./scheduler";

const log = createLogger("worker.tasks");

/** Scan de la boîte Outlook : delta query → SQLite. L'analyse Claude arrive en phase 2. */
export const scanMailboxTask = (intervalSeconds: number): WorkerTask => ({
  name: "scan_mailbox",
  intervalSeconds,
  lockTtlSeconds: Math.max(120, intervalSeconds * 2),
  run: async () => {
    if (!isOutlookConnected()) {
      log.debug("scan_mailbox: Outlook non connecté");
      return;
    }
    const result = await syncInbox(createConnectedGraphClient());
    if (result.inserted > 0 || result.errors.length > 0) log.info("scan_mailbox done", { inserted: result.inserted, attachments: result.attachments, pages: result.pages, errors: result.errors.length });
    if (result.inserted > 0) await runAnalysis(result.inserted);
  },
});

async function runAnalysis(limit: number): Promise<void> {
  if (!getConfiguredIntegrations().anthropic) {
    log.debug("analyze_emails: ANTHROPIC_API_KEY absente");
    return;
  }
  const r = await analyzePendingEmails(limit);
  if (r.attempted > 0 || r.staleFailed > 0) log.info("analyze_emails done", { attempted: r.attempted, succeeded: r.succeeded, failed: r.failed, staleFailed: r.staleFailed });
}

/** Analyse Claude des emails NEW (rattrapage entre deux scans, jamais les ANALYSIS_FAILED). */
export const analyzeEmailsTask: WorkerTask = {
  name: "analyze_emails",
  intervalSeconds: 60,
  lockTtlSeconds: 600,
  run: () => runAnalysis(5),
};

/**
 * Relances et rappels (phase 7). Sous verrou SQLite : une seule exécution à la
 * fois, tous process confondus. Ordre : réconciliation des relances déjà
 * validées → échéances (vérification Outlook obligatoire) → notifications
 * proactives restées en attente.
 */
export const processFollowupsTask: WorkerTask = {
  name: "process_followups",
  intervalSeconds: 300,
  lockTtlSeconds: 900,
  run: async () => {
    if (!getSettings().followups.enabled) return;
    const reconciled = reconcileFollowups();
    const results = await processDueFollowups();
    kvSet("worker.last_followup_check_at", nowIso());
    // Notifications proactives jamais parties (WhatsApp indisponible, fenêtre fermée).
    let renotified = 0;
    for (const f of listFollowups({ status: ["REMINDED", "MAX_ATTEMPTS_REACHED", "REVIEW_REQUIRED"], limit: 50 })) {
      if (f.notification_pending === 1 && f.notified_at === null && f.notify_attempts < 5) {
        const ok = await notifyFollowup(f.id, `⏰ EMA — ${f.title ?? f.reason}`);
        if (ok) renotified++;
      }
    }
    if (reconciled.length || results.length || renotified) {
      log.info("followups processed", { reconciled: reconciled.length, due: results.length, renotified, outcomes: results.map((r) => r.outcome) });
    }
  },
};

/**
 * Reprise après interruption (phase 8A). Une action validée mais jamais exécutée
 * repart ; une action interrompue en cours d'exécution est réconciliée avec
 * Outlook — jamais rejouée à l'aveugle. Les webhooks bloqués en PROCESSING sont
 * remis en état reprenable plutôt que perdus.
 */
export const recoverStaleActionsTask: WorkerTask = {
  name: "recover_stale_actions",
  intervalSeconds: 60,
  lockTtlSeconds: 300,
  run: async () => {
    const report = await recoverStaleActions();
    if (report.resumed.length || report.reconciled.length || report.ambiguous.length) {
      log.info("stale actions recovered", { resumed: report.resumed.length, reconciled: report.reconciled.length, ambiguous: report.ambiguous.length, skipped: report.skipped.length });
    }
    let released = 0;
    for (const event of listStaleWebhookEvents(20)) {
      failWebhookEvent(event.provider, event.external_id, "Traitement interrompu : événement repris", getDb());
      logHistory({ eventType: "webhook.interrupted", message: `Événement ${event.provider} interrompu (tentative ${event.attempts}) : redevenu reprenable`, actor: "system" });
      released++;
    }
    if (released) log.info("stale webhook events released", { released });
  },
};

/** Expiration des validations en attente. */
export const expireApprovalsTask: WorkerTask = {
  name: "expire_approvals",
  intervalSeconds: 600,
  lockTtlSeconds: 120,
  run: async () => {
    const n = expireApprovals();
    if (n > 0) log.info("approvals expired", { count: n });
  },
};

/** Documents PDF jamais analysés (téléchargés à la demande, ou analyse interrompue). */
export const analyzeDocumentsTask: WorkerTask = {
  name: "analyze_documents",
  intervalSeconds: 300,
  lockTtlSeconds: 600,
  run: async () => {
    if (!getConfiguredIntegrations().anthropic) return;
    let n = 0;
    for (const doc of listDocumentsPendingAnalysis(5)) {
      try {
        await analyzeDocument(doc.id);
        n++;
      } catch (err) {
        log.warn("document analysis failed", { documentId: doc.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (n > 0) log.info("documents analyzed", { count: n });
  },
};

/** Notifications WhatsApp jamais parties (WhatsApp indisponible au moment de l'analyse). */
export const notifyApprovalsTask: WorkerTask = {
  name: "notify_approvals",
  intervalSeconds: 120,
  lockTtlSeconds: 300,
  run: async () => {
    if (!isWhatsappConfigured()) return;
    const n = await notifyUnsentApprovals();
    if (n > 0) log.info("approval notifications sent", { count: n });
  },
};

export const heartbeatTask: WorkerTask = {
  name: "heartbeat",
  intervalSeconds: 30,
  lockTtlSeconds: 20,
  run: async () => {
    kvSet("worker.heartbeat_at", nowIso());
  },
};
