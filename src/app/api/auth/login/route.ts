import { z } from "zod";
import { NextResponse } from "next/server";
import { route, parseBody, fail } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { logHistory } from "@/database/repositories/history";
import { publicUser } from "@/database/repositories/users";
import { createSessionValue, isAuthConfigured, sessionCookieOptions } from "@/security/auth";
import { authenticate } from "@/security/accounts";
import { clientKey, hitRateLimit, resetRateLimit } from "@/security/rate-limit";

/** Connexion par compte : email + mot de passe → cookie de session signé. Jamais de mot de passe journalisé. */
export const POST = route(
  async (req) => {
    if (!isAuthConfigured()) throw new EmaError("CONFIG", "APP_SECRET non configuré");
    const key = clientKey(req);
    const limit = hitRateLimit(key);
    if (!limit.allowed) {
      logHistory({ eventType: "auth.rate_limited", message: "Trop de tentatives de connexion : accès temporairement bloqué", actor: "system" });
      return fail(new EmaError("FORBIDDEN", `Trop de tentatives. Réessayez dans ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`));
    }
    const { email, password } = await parseBody(req, z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(512) }));
    const user = authenticate(email, password);
    if (!user) {
      logHistory({ eventType: "auth.failed", message: "Tentative de connexion refusée (identifiants incorrects)", actor: "system" });
      return fail(new EmaError("UNAUTHORIZED", "Email ou mot de passe incorrect"));
    }
    resetRateLimit(key);
    logHistory({ eventType: "auth.login", message: `Connexion à l'interface EMA (${user.email})`, actor: "user", userId: user.id });
    const res = NextResponse.json({ ok: true, data: { authenticated: true, user: publicUser(user) } });
    const { name, ...opts } = sessionCookieOptions();
    res.cookies.set(name, createSessionValue(user.id), opts);
    return res;
  },
  { public: true },
);
