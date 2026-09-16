import { getDb } from "@/database/connection";
import { ensureConfigFile } from "./config";
import { assertEnvUsable } from "./env";
import { ensurePrivateDirs, hardenSensitiveFiles } from "./paths";
import { registerDefaultExecutors } from "@/actions/executors";
import { registerAllTools } from "@/tools";

const g = globalThis as unknown as { __emaBootstrapped?: boolean };

/** Initialisation idempotente d'un process (web ou worker). */
export function bootstrap(): void {
  if (g.__emaBootstrapped) return;
  // Refuse de démarrer dans un état partiellement sécurisé (production).
  assertEnvUsable();
  ensurePrivateDirs();
  hardenSensitiveFiles();
  for (const name of ["settings", "rules", "contacts", "companies"] as const) ensureConfigFile(name);
  getDb();
  registerDefaultExecutors();
  registerAllTools();
  g.__emaBootstrapped = true;
}
