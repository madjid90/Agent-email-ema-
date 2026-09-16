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

/** Droits des dossiers contenant des données client : propriétaire uniquement. */
export const PRIVATE_DIR_MODE = 0o700;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

export function ensurePrivateDirs(): void {
  const root = privateRoot();
  ensureDir(root);
  for (const d of PRIVATE_DIRS) ensureDir(path.join(root, d));
  const dbDir = path.dirname(databasePath());
  if (databasePath() !== ":memory:") ensureDir(dbDir);
  // Resserre les droits même si les dossiers existaient déjà (installation antérieure).
  for (const dir of [root, ...PRIVATE_DIRS.map((d) => path.join(root, d)), dbDir]) {
    try {
      fs.chmodSync(dir, PRIVATE_DIR_MODE);
    } catch {
      /* système de fichiers sans droits POSIX : ignoré, signalé par le diagnostic */
    }
  }
}

/**
 * Resserre les droits des fichiers sensibles créés hors d'EMA (.env copié à la
 * main, base restaurée depuis une sauvegarde). Silencieux si le système de
 * fichiers ne gère pas les droits POSIX.
 */
export function hardenSensitiveFiles(): void {
  const files = [resolveFromRoot(".env"), ...(databasePath() === ":memory:" ? [] : [databasePath(), `${databasePath()}-wal`, `${databasePath()}-shm`])];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    } catch {
      /* ignoré : signalé par le diagnostic */
    }
  }
  try {
    if (fs.existsSync(configRoot())) fs.chmodSync(configRoot(), PRIVATE_DIR_MODE);
  } catch {
    /* ignoré */
  }
}

export interface PathPermission {
  path: string;
  exists: boolean;
  /** Droits POSIX (ex. "700"). */
  mode: string | null;
  /** true si le fichier/dossier est lisible par le groupe ou les autres. */
  worldReadable: boolean;
}

/** État des droits des chemins sensibles (diagnostic, jamais de contenu lu). */
export function inspectPermissions(): PathPermission[] {
  const targets = [resolveFromRoot(".env"), privateRoot(), ...PRIVATE_DIRS.map((d) => path.join(privateRoot(), d)), configRoot(), ...(databasePath() === ":memory:" ? [] : [databasePath()])];
  return targets.map((target) => {
    try {
      const st = fs.statSync(target);
      const mode = st.mode & 0o777;
      return { path: target, exists: true, mode: mode.toString(8).padStart(3, "0"), worldReadable: (mode & 0o077) !== 0 };
    } catch {
      return { path: target, exists: false, mode: null, worldReadable: false };
    }
  });
}

/** Nom de fichier sûr : ASCII, sans séparateur, longueur bornée. */
export function sanitizeFilename(name: string, fallback = "fichier"): string {
  const base = path.basename(name).normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  const trimmed = base.slice(0, 120);
  return trimmed.length > 0 ? trimmed : fallback;
}
