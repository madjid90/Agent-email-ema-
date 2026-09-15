import { z } from "zod";
import { NextResponse } from "next/server";
import { route, parseBody, fail } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { createSessionValue, isAuthConfigured, sessionCookieOptions, verifyPassword } from "@/security/auth";

export const POST = route(
  async (req) => {
    if (!isAuthConfigured()) throw new EmaError("CONFIG", "APP_PASSWORD / APP_SECRET non configurés");
    const { password } = await parseBody(req, z.object({ password: z.string().min(1) }));
    if (!verifyPassword(password)) return fail(new EmaError("UNAUTHORIZED", "Mot de passe incorrect"));
    const res = NextResponse.json({ ok: true, data: { authenticated: true } });
    const { name, ...opts } = sessionCookieOptions();
    res.cookies.set(name, createSessionValue(), opts);
    return res;
  },
  { public: true },
);
