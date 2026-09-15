import { route, ok, parseBody } from "@/lib/api";
import { companiesFileSchema, readConfig, writeConfig } from "@/lib/config";
import { EmaError } from "@/lib/errors";

export const GET = route(async () => ok(readConfig("companies")));

export const PUT = route(async (req) => {
  const body = await parseBody(req, companiesFileSchema);
  const ids = new Set<string>();
  for (const c of body.companies) {
    if (ids.has(c.id)) throw new EmaError("VALIDATION", `Identifiant de société en double : ${c.id}`);
    ids.add(c.id);
    if (c.signaturePath && !/^signatures\/[\w.\-]+\.png$/.test(c.signaturePath)) throw new EmaError("VALIDATION", `Chemin de signature invalide pour ${c.id}`);
    if (c.stampPath && !/^stamps\/[\w.\-]+\.png$/.test(c.stampPath)) throw new EmaError("VALIDATION", `Chemin de tampon invalide pour ${c.id}`);
  }
  return ok(writeConfig("companies", body));
});
