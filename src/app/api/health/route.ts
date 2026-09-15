import { route, ok } from "@/lib/api";
import { getDb } from "@/database/connection";
import pkg from "../../../../package.json";

export const GET = route(
  async () => {
    getDb().prepare("SELECT 1").get();
    return ok({ status: "ok", version: pkg.version, time: new Date().toISOString() });
  },
  { public: true },
);
