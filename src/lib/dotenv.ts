import fs from "node:fs";
import path from "node:path";

/**
 * Chargement de `.env` pour les process qui ne passent pas par Next.js
 * (worker PM2, `npm run doctor`, migrations). Next.js charge déjà le fichier
 * pour l'application web : les variables déjà présentes ne sont jamais écrasées.
 * Aucune dépendance externe, aucune valeur journalisée.
 */
let loaded = false;

function defaultEnvFile(): string {
  return path.resolve(process.cwd(), ".env");
}

export function loadDotEnv(file = defaultEnvFile()): number {
  // Les tests fournissent leur propre environnement : ne jamais charger le .env local.
  if (process.env.VITEST && file === defaultEnvFile()) return 0;
  if (loaded) return 0;
  loaded = true;
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  let applied = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value.replace(/\\n/g, "\n");
    applied++;
  }
  return applied;
}

export function resetDotEnvForTests(): void {
  loaded = false;
}
