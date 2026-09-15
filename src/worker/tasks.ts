import { expireApprovals } from "@/actions/engine";
import { listDueFollowups } from "@/database/repositories/followups";
import { kvSet } from "@/database/repositories/kv";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import type { WorkerTask } from "./scheduler";

const log = createLogger("worker.tasks");

/** Scan de la boîte Outlook (phase 1) : pour l'instant, enregistre juste le heartbeat. */
export const scanMailboxTask = (intervalSeconds: number): WorkerTask => ({
  name: "scan_mailbox",
  intervalSeconds,
  lockTtlSeconds: Math.max(60, intervalSeconds * 2),
  run: async () => {
    kvSet("worker.last_scan_at", nowIso());
    log.debug("scan_mailbox: Graph non branché (phase 1)");
  },
});

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

export const heartbeatTask: WorkerTask = {
  name: "heartbeat",
  intervalSeconds: 30,
  lockTtlSeconds: 20,
  run: async () => {
    kvSet("worker.heartbeat_at", nowIso());
  },
};
