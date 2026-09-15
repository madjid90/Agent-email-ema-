import { getEnv } from "@/lib/env";
import { getDb, closeDb } from "@/database/connection";
import { ensurePrivateDirs } from "@/lib/paths";
import { createLogger } from "@/lib/logger";
import { registerDefaultExecutors } from "@/actions/executors";
import { registerAllTools } from "@/tools";
import { startScheduler } from "./scheduler";
import { analyzeEmailsTask, expireApprovalsTask, heartbeatTask, notifyApprovalsTask, processFollowupsTask, scanMailboxTask } from "./tasks";

const log = createLogger("worker.main");

function main(): void {
  const env = getEnv();
  ensurePrivateDirs();
  getDb();
  registerDefaultExecutors();
  registerAllTools();

  const handle = startScheduler([heartbeatTask, scanMailboxTask(env.WORKER_POLL_INTERVAL), analyzeEmailsTask, notifyApprovalsTask, processFollowupsTask, expireApprovalsTask]);
  log.info("EMA worker started", { pollInterval: env.WORKER_POLL_INTERVAL });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    handle.stop();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
