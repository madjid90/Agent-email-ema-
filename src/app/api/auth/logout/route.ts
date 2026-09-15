import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE } from "@/security/auth";

export const POST = route(
  async () => {
    const res = NextResponse.redirect(new URL("/login", getEnv().APP_URL), { status: 303 });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  },
  { public: true },
);
