import { getEnv } from "@/lib/env";
import { closeDb } from "@/database/connection";
import { bootstrap } from "@/lib/bootstrap";
import { createLogger } from "@/lib/logger";
import { EmaError } from "@/lib/errors";
import { startScheduler } from "./scheduler";
import { analyzeDocumentsTask, analyzeEmailsTask, expireApprovalsTask, heartbeatTask, notifyApprovalsTask, processFollowupsTask, recoverStaleActionsTask, scanMailboxTask } from "./tasks";

const log = createLogger("worker.main");

/**
 * Démarrage du worker. Il subit exactement les mêmes contrôles que le process
 * web : `bootstrap()` valide l'environnement (démarrage refusé en production si
 * la configuration est bloquante), crée et resserre `private/` et `data/`,
 * initialise la configuration, la base, les exécuteurs et les tools. La fonction
 * est idempotente : aucun double enregistrement, même si le web et le worker
 * partagent un process (tests).
 */
export function startWorker(): { stop: () => void } {
  bootstrap();
  const env = getEnv();
  const handle = startScheduler([heartbeatTask, scanMailboxTask(env.WORKER_POLL_INTERVAL), analyzeEmailsTask, analyzeDocumentsTask, notifyApprovalsTask, processFollowupsTask, recoverStaleActionsTask, expireApprovalsTask]);
  log.info("EMA worker started", { pollInterval: env.WORKER_POLL_INTERVAL });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    handle.stop();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return handle;
}

function main(): void {
  try {
    startWorker();
  } catch (err) {
    // Configuration bloquante (production) : le worker ne démarre pas à moitié.
    const message = err instanceof EmaError ? err.message : err instanceof Error ? err.message : String(err);
    log.error("worker startup refused", { message });
    console.error(`\nDémarrage du worker refusé : ${message}\n`);
    process.exit(1);
  }
}

// Exécuté uniquement en tant que process (jamais à l'import depuis un test).
if (process.env.VITEST === undefined) main();
