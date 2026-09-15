import { NextResponse } from "next/server";
import { z } from "zod";
import { EmaError, toEmaError } from "@/lib/errors";
import { isAuthenticated } from "@/security/auth";
import { bootstrap } from "./bootstrap";
import { createLogger } from "./logger";

const log = createLogger("api");

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(err: unknown): NextResponse {
  const e = err instanceof EmaError ? err : toEmaError(err);
  if (e.status >= 500 && e.code !== "NOT_IMPLEMENTED") log.error("api error", { code: e.code, message: e.message });
  else if (e.status >= 400) log.warn("api rejected", { code: e.code, message: e.message });
  return NextResponse.json({ ok: false, error: e.toJSON() }, { status: e.status });
}

/**
 * Enveloppe standard d'une route API : bootstrap, authentification (sauf
 * routes publiques), gestion d'erreur uniforme.
 */
export function route<Ctx>(handler: (req: Request, ctx: Ctx) => Promise<NextResponse>, opts: { public?: boolean } = {}) {
  return async (req: Request, ctx: Ctx): Promise<NextResponse> => {
    try {
      bootstrap();
      if (!opts.public && !(await isAuthenticated())) throw new EmaError("UNAUTHORIZED", "Authentification requise");
      return await handler(req, ctx);
    } catch (err) {
      return fail(err);
    }
  };
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
