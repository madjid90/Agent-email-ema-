import { route, ok } from "@/lib/api";
import { getDb } from "@/database/connection";
import { isAuthenticated } from "@/security/auth";
import { activitySummary, costReport, runChecks } from "@/lib/diagnostics";
import pkg from "../../../../package.json";

/**
 * Santé de l'instance. Réponse publique minimale (supervision externe, Nginx) ;
 * le détail complet (contrôles, disque, worker, coûts) n'est renvoyé qu'à une
 * session authentifiée. Aucun secret n'est exposé dans les deux cas.
 */
export const GET = route(
  async () => {
    getDb().prepare("SELECT 1").get();
    if (!(await isAuthenticated())) {
      return ok({ status: "ok", version: pkg.version, time: new Date().toISOString() });
    }
    const report = runChecks(pkg.version);
    return ok({ ...report, activity: activitySummary(), costs: costReport(7) }, { status: report.status === "FAIL" ? 503 : 200 });
  },
  { public: true },
);
