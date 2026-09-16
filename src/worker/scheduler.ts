import { acquireLock, releaseLock } from "@/database/repositories/locks";
import { createLogger } from "@/lib/logger";
import { newId } from "@/lib/ids";

const log = createLogger("worker");

export interface WorkerTask {
  name: string;
  /** Intervalle entre deux exécutions (secondes). */
  intervalSeconds: number;
  /** Durée max de verrou (secondes). */
  lockTtlSeconds: number;
  run: () => Promise<void>;
}

export interface TaskRunResult {
  name: string;
  ran: boolean;
  error?: string;
}

/**
 * Exécute une tâche sous verrou SQLite. L'owner est unique PAR EXÉCUTION :
 * si le tick précédent tourne encore, le suivant n'obtient pas le verrou et ne
 * démarre pas — même process, même tâche, même machine.
 */
export async function runTaskOnce(task: WorkerTask, workerId: string = newId("wrk")): Promise<TaskRunResult> {
  const owner = `${workerId}:${task.name}:${newId("run")}`;
  if (!acquireLock(`task:${task.name}`, owner, task.lockTtlSeconds)) {
    return { name: task.name, ran: false };
  }
  try {
    await task.run();
    return { name: task.name, ran: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    log.error("task failed", { task: task.name, message });
    return { name: task.name, ran: true, error: message };
  } finally {
    releaseLock(`task:${task.name}`, owner);
  }
}

export interface SchedulerHandle {
  stop: () => void;
}

/** Boucle simple : chaque tâche a son propre setInterval, sans chevauchement grâce au verrou. */
export function startScheduler(tasks: WorkerTask[]): SchedulerHandle {
  const workerId = newId("wrk");
  // Le premier tick différé est mémorisé au même titre que l'intervalle : après
  // `stop()`, plus aucune tâche ne doit démarrer (arrêt du worker, tests).
  const timers: NodeJS.Timeout[] = [];
  for (const task of tasks) {
    const tick = () => void runTaskOnce(task, workerId);
    timers.push(setTimeout(tick, 1000));
    timers.push(setInterval(tick, task.intervalSeconds * 1000));
  }
  log.info("scheduler started", { tasks: tasks.map((t) => `${t.name}@${t.intervalSeconds}s`) });
  return {
    stop: () => {
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      log.info("scheduler stopped");
    },
  };
}
