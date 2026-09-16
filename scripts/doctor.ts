import fs from "node:fs";
import process from "node:process";
import { bootstrap } from "@/lib/bootstrap";
import { closeDb } from "@/database/connection";
import { activitySummary, costReport, mb, runChecks, type Check, type CheckLevel } from "@/lib/diagnostics";
import { inspectPermissions } from "@/lib/paths";
import { resetEnvCache } from "@/lib/env";
import pkg from "../package.json";

/**
 * `npm run doctor` — diagnostic d'installation. N'affiche jamais un secret :
 * seulement la présence ou l'absence d'une configuration. Code de sortie 1 si
 * au moins un contrôle est en FAIL.
 */
const COLORS: Record<CheckLevel, string> = { PASS: "\u001b[32m", WARN: "\u001b[33m", FAIL: "\u001b[31m" };
const RESET = "\u001b[0m";

function line(check: Check): string {
  return `${COLORS[check.level]}${check.level.padEnd(4)}${RESET} ${check.name.padEnd(22)} ${check.detail}`;
}

function report(checks: Check[]): void {
  for (const c of checks) console.log(line(c));
  const fails = checks.filter((c) => c.level === "FAIL").length;
  const warns = checks.filter((c) => c.level === "WARN").length;
  console.log(`\n${checks.length} contrôle(s) — ${checks.length - fails - warns} PASS, ${warns} WARN, ${fails} FAIL`);
  if (fails) console.log("\nEMA n'est pas prêt : corriger les FAIL ci-dessus (voir docs/deployment.md).");
  else if (warns) console.log("\nEMA peut démarrer ; les WARN signalent une configuration incomplète (voir docs/deployment.md).");
  else console.log("\nInstallation complète.");
}

function main(): void {
  console.log(`EMA doctor — version ${pkg.version}, Node ${process.version}\n`);
  const checks: Check[] = [];

  const major = Number(process.version.replace("v", "").split(".")[0]);
  checks.push({ name: "Node.js", level: major >= 20 ? "PASS" : "FAIL", detail: `${process.version} (20 minimum, 22 LTS recommandé)` });
  checks.push({ name: ".env", level: fs.existsSync(".env") ? "PASS" : "FAIL", detail: fs.existsSync(".env") ? "présent" : "absent — copier .env.example puis compléter" });

  try {
    resetEnvCache();
    bootstrap();
  } catch (err) {
    checks.push({ name: "démarrage", level: "FAIL", detail: err instanceof Error ? err.message : String(err) });
    report(checks);
    process.exit(1);
  }

  const health = runChecks(pkg.version);
  checks.push(...health.checks);

  for (const p of inspectPermissions()) {
    if (p.exists && p.worldReadable) checks.push({ name: "droits", level: "WARN", detail: `${p.path} en ${p.mode} : restreindre à 700 (dossier) ou 600 (fichier)` });
  }

  const activity = activitySummary();
  checks.push({ name: "activité", level: "PASS", detail: `${activity.pendingActions} action(s) à valider · ${activity.activeFollowups} relance(s) active(s) · ${activity.notificationsPending} notification(s) en attente` });

  const costs = costReport(7);
  checks.push({ name: "coût Claude (jour)", level: "PASS", detail: `${costs.today.runs} appel(s), ${costs.today.inputTokens} in / ${costs.today.outputTokens} out, ≈ ${costs.today.estimatedCost} ${costs.currency}` });
  checks.push({ name: "stockage", level: "PASS", detail: `base ${mb(health.disk.databaseBytes)} · private ${mb(health.disk.privateBytes)} · sauvegardes ${mb(health.disk.backupsBytes)}` });

  report(checks);
  closeDb();
  process.exit(checks.some((c) => c.level === "FAIL") ? 1 : 0);
}

main();
