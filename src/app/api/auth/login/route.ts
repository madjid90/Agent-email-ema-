import { z } from "zod";
import { NextResponse } from "next/server";
import { route, parseBody, fail } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { logHistory } from "@/database/repositories/history";
import { createSessionValue, isAuthConfigured, sessionCookieOptions, verifyPassword } from "@/security/auth";
import { clientKey, hitRateLimit, resetRateLimit } from "@/security/rate-limit";

export const POST = route(
  async (req) => {
    if (!isAuthConfigured()) throw new EmaError("CONFIG", "APP_PASSWORD / APP_SECRET non configurés");
    const key = clientKey(req);
    const limit = hitRateLimit(key);
    if (!limit.allowed) {
      logHistory({ eventType: "auth.rate_limited", message: "Trop de tentatives de connexion : accès temporairement bloqué", actor: "system" });
      return fail(new EmaError("FORBIDDEN", `Trop de tentatives. Réessayez dans ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`));
    }
    const { password } = await parseBody(req, z.object({ password: z.string().min(1).max(512) }));
    if (!verifyPassword(password)) {
      logHistory({ eventType: "auth.failed", message: "Tentative de connexion refusée (mot de passe incorrect)", actor: "system" });
      return fail(new EmaError("UNAUTHORIZED", "Mot de passe incorrect"));
    }
    resetRateLimit(key);
    logHistory({ eventType: "auth.login", message: "Connexion à l'interface EMA", actor: "user" });
    const res = NextResponse.json({ ok: true, data: { authenticated: true } });
    const { name, ...opts } = sessionCookieOptions();
    res.cookies.set(name, createSessionValue(), opts);
    return res;
  },
  { public: true },
);
