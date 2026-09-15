import path from "node:path";
import fs from "node:fs";
import { getEnv } from "./env";
import { EmaError } from "./errors";

export function projectRoot(): string {
  return process.cwd();
}

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectRoot(), p);
}

export function privateRoot(): string {
  return resolveFromRoot(getEnv().PRIVATE_STORAGE_PATH);
}

export function configRoot(): string {
  return resolveFromRoot(getEnv().CONFIG_PATH);
}

export function databasePath(): string {
  const p = getEnv().DATABASE_PATH;
  return p === ":memory:" ? p : resolveFromRoot(p);
}

export const PRIVATE_DIRS = ["documents", "signatures", "stamps", "signed-documents"] as const;
export type PrivateDir = (typeof PRIVATE_DIRS)[number];

/**
 * Joint un chemin relatif à un dossier privé en refusant toute sortie du dossier
 * (protection contre `..`, chemins absolus, etc.).
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...segments);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw new EmaError("FORBIDDEN", "Chemin hors du dossier autorisé");
  }
  return target;
}

export function privatePath(dir: PrivateDir, ...segments: string[]): string {
  return safeJoin(path.join(privateRoot(), dir), ...segments);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensurePrivateDirs(): void {
  for (const d of PRIVATE_DIRS) ensureDir(path.join(privateRoot(), d));
}

/** Nom de fichier sûr : ASCII, sans séparateur, longueur bornée. */
export function sanitizeFilename(name: string, fallback = "fichier"): string {
  const base = path.basename(name).normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  const trimmed = base.slice(0, 120);
  return trimmed.length > 0 ? trimmed : fallback;
}
