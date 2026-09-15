import { route, ok, parseBody } from "@/lib/api";
import { readConfig, rulesFileSchema, writeConfig } from "@/lib/config";
import { EmaError } from "@/lib/errors";

export const GET = route(async () => ok(readConfig("rules")));

export const PUT = route(async (req) => {
  const body = await parseBody(req, rulesFileSchema);
  const ids = new Set<string>();
  for (const r of body.rules) {
    if (ids.has(r.id)) throw new EmaError("VALIDATION", `Identifiant de règle en double : ${r.id}`);
    ids.add(r.id);
  }
  return ok(writeConfig("rules", body));
});
