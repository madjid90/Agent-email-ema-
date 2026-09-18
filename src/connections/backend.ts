import { getEnv, type Env } from "@/lib/env";

export type ConnectionBackend = "native" | "composio";

/**
 * Migration progressive :
 * - native tant que Composio n'est pas explicitement activé ;
 * - composio uniquement si le flag ET la clé sont présents.
 *
 * On ne bascule jamais implicitement un client existant.
 */
export function resolveConnectionBackend(env: Env = getEnv()): ConnectionBackend {
  return env.COMPOSIO_ENABLED && Boolean(env.COMPOSIO_API_KEY) ? "composio" : "native";
}
