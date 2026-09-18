import { z } from "zod";
import { NextResponse } from "next/server";
import { route, parseBody, ok } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { publicUser } from "@/database/repositories/users";
import { createSessionValue, isAuthConfigured, sessionCookieOptions } from "@/security/auth";
import { isSignupAllowed, registerAccount } from "@/security/accounts";
import { clientKey, hitRateLimit } from "@/security/rate-limit";

/** Disponibilité de l'inscription (premier compte, ou ALLOW_SIGNUP=true). */
export const GET = route(async () => ok({ allowed: isSignupAllowed() }), { public: true });

/** Création d'un compte dirigeant, puis connexion immédiate. */
export const POST = route(
  async (req) => {
    if (!isAuthConfigured()) throw new EmaError("CONFIG", "APP_SECRET non configuré");
    const limit = hitRateLimit(clientKey(req, "register"), { max: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });
    if (!limit.allowed) throw new EmaError("FORBIDDEN", "Trop de tentatives. Réessayez plus tard.");
    const body = await parseBody(
      req,
      z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(512), name: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional() }),
    );
    const user = registerAccount({ email: body.email, password: body.password, name: body.name ?? null, phoneNumber: body.phone || null });
    const res = NextResponse.json({ ok: true, data: { authenticated: true, user: publicUser(user) } }, { status: 201 });
    const { name, ...opts } = sessionCookieOptions();
    res.cookies.set(name, createSessionValue(user.id), opts);
    return res;
  },
  { public: true },
);
