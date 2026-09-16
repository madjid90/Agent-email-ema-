import { getEnv } from "./env";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = /token|secret|password|passphrase|api_key|apikey|authorization|refresh|access|cookie|session|credential|private_key|signature_path|stamp_path/i;

/** Adresses email masquées dans les journaux : `j***@domaine.fr`. */
const EMAIL_RE = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
/** Numéros de téléphone (8 chiffres ou plus) masqués. */
const PHONE_RE = /\b(\+?\d{2})\d{4,}(\d{2})\b/g;

export function maskPersonalData(text: string): string {
  return text.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`).replace(PHONE_RE, (_m, head: string, tail: string) => `${head}…${tail}`);
}

/** Masque récursivement les champs sensibles avant écriture dans les logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return maskPersonalData(value);
  return value;
}

function write(level: Level, scope: string, msg: string, data?: Record<string, unknown>): void {
  const env = getEnv();
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: maskPersonalData(msg),
    ...(data ? { data: redact(data) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => write("debug", scope, m, d),
    info: (m, d) => write("info", scope, m, d),
    warn: (m, d) => write("warn", scope, m, d),
    error: (m, d) => write("error", scope, m, d),
  };
}
