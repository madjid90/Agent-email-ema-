import { NextResponse } from "next/server";
import { z } from "zod";
import { EmaError, toEmaError } from "@/lib/errors";
import { getSessionUser } from "@/security/auth";
import type { UserRow } from "@/database/types";
import { bootstrap } from "./bootstrap";
import { createLogger } from "./logger";

const log = createLogger("api");

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(err: unknown): NextResponse {
  const e = err instanceof EmaError ? err : toEmaError(err);
  // Le détail technique va dans les journaux ; l'utilisateur reçoit un message lisible.
  if (e.status >= 500 && e.code !== "NOT_IMPLEMENTED") {
    log.error("api error", { code: e.code, message: e.message, cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : undefined });
  } else if (e.status >= 400) {
    log.warn("api rejected", { code: e.code, message: e.message });
  }
  return NextResponse.json({ ok: false, error: e.toJSON() }, { status: e.status });
}

/**
 * Enveloppe standard d'une route API : bootstrap, authentification (sauf
 * routes publiques), gestion d'erreur uniforme. Le handler reçoit l'utilisateur
 * de session (null sur une route publique) : c'est la seule source d'identité.
 */
export function route<Ctx>(handler: (req: Request, ctx: Ctx, user: UserRow | null) => Promise<NextResponse>, opts: { public?: boolean } = {}) {
  return async (req: Request, ctx: Ctx): Promise<NextResponse> => {
    try {
      bootstrap();
      const user = await getSessionUser();
      if (!opts.public && !user) throw new EmaError("UNAUTHORIZED", "Authentification requise");
      return await handler(req, ctx, user);
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Isolation : une ressource d'un autre compte est traitée comme inexistante.
 * Une ligne sans propriétaire (antérieure à 010_users) reste accessible.
 */
export function ownedOr404<T extends { user_id: string | null }>(row: T | undefined | null, user: UserRow, what: string): T {
  if (!row || (row.user_id && row.user_id !== user.id)) throw new EmaError("NOT_FOUND", `${what} introuvable`);
  return row;
}

/** Utilisateur garanti (routes non publiques). */
export function currentUser(user: UserRow | null): UserRow {
  if (!user) throw new EmaError("UNAUTHORIZED", "Authentification requise");
  return user;
}

export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new EmaError("VALIDATION", "Corps JSON invalide");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new EmaError("VALIDATION", "Données invalides", { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  return parsed.data;
}

export async function paramsOf<T>(ctx: { params: Promise<T> }): Promise<T> {
  return ctx.params;
}
