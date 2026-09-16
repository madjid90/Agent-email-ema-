/**
 * Erreurs applicatives typées. Toujours lever une EmaError avec un code stable
 * plutôt qu'une Error générique : le code est renvoyé à l'UI et à Claude,
 * jamais la stack ni un secret.
 */
export type EmaErrorCode =
  | "NOT_IMPLEMENTED"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFIG"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INTEGRATION"
  | "APPROVAL_REQUIRED"
  | "INVALID_TRANSITION"
  | "INTERNAL";

export class EmaError extends Error {
  readonly code: EmaErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: EmaErrorCode, message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "EmaError";
    this.code = code;
    this.status = options?.status ?? defaultStatus(code);
    this.details = options?.details;
  }

  toJSON(): { code: EmaErrorCode; message: string; details?: unknown } {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

function defaultStatus(code: EmaErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "CONFLICT":
    case "INVALID_TRANSITION":
      return 409;
    case "NOT_IMPLEMENTED":
      return 501;
    case "INTEGRATION":
      return 502;
    default:
      return 500;
  }
}

export class NotImplementedError extends EmaError {
  constructor(feature: string, phase?: string) {
    super("NOT_IMPLEMENTED", phase ? `${feature} n'est pas encore implémenté (prévu en ${phase}).` : `${feature} n'est pas encore implémenté.`);
    this.name = "NotImplementedError";
  }
}

/**
 * Message générique affiché à l'utilisateur pour une erreur technique.
 * Le détail (SQLITE_CONSTRAINT, ENOENT, stack…) reste dans les logs serveur.
 */
export const GENERIC_INTERNAL_MESSAGE = "EMA n'a pas pu traiter cette opération. Le détail technique est dans les journaux du serveur.";

/** Erreurs techniques dont le message ne doit jamais être affiché tel quel. */
const TECHNICAL_ERROR = /^(SQLITE_|ENOENT|EACCES|EPERM|EEXIST|EPIPE|ECONN|ETIMEDOUT|ERR_|TypeError|ReferenceError|RangeError|SyntaxError|Cannot read|Cannot set|undefined is not|null is not|.*\bat\s+\/)/i;

export function isTechnicalMessage(message: string): boolean {
  return TECHNICAL_ERROR.test(message.trim());
}

/** Convertit n'importe quelle erreur en EmaError sans fuite d'information. */
export function toEmaError(err: unknown): EmaError {
  if (err instanceof EmaError) return err;
  if (err instanceof Error) {
    const message = isTechnicalMessage(err.message) ? GENERIC_INTERNAL_MESSAGE : err.message;
    return new EmaError("INTERNAL", message, { cause: err });
  }
  return new EmaError("INTERNAL", GENERIC_INTERNAL_MESSAGE);
}
