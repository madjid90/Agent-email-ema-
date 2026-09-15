import { expireApprovals } from "@/actions/engine";
import { listDueFollowups } from "@/database/repositories/followups";
import { kvSet } from "@/database/repositories/kv";
import { createConnectedGraphClient, isOutlookConnected, syncInbox } from "@/integrations/microsoft";
import { analyzePendingEmails } from "@/agent/orchestrator";
import { notifyUnsentApprovals, isWhatsappConfigured } from "@/integrations/whatsapp";
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

/** Relances échues (phase 6) : liste les relances dues et journalise. */
export const processFollowupsTask: WorkerTask = {
  name: "process_followups",
  intervalSeconds: 300,
  lockTtlSeconds: 600,
  run: async () => {
    const due = listDueFollowups();
    kvSet("worker.last_followup_check_at", nowIso());
    if (due.length) log.info("followups due", { count: due.length });
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
