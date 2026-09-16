import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { openIsolatedDb, type Db } from "@/database/connection";
import { assertEnvUsable, checkEnv, getEnv, resetEnvCache } from "@/lib/env";
import { loadDotEnv, resetDotEnvForTests } from "@/lib/dotenv";
import { clearRateLimits, clientKey, hitRateLimit, LOGIN_RATE_LIMIT, resetRateLimit } from "@/security/rate-limit";
import { isSessionValueValid, createSessionValue, sessionCookieOptions, verifyPassword } from "@/security/auth";
import { maskPersonalData, redact } from "@/lib/logger";
import { GENERIC_INTERNAL_MESSAGE, EmaError, toEmaError, isTechnicalMessage } from "@/lib/errors";
import { ensurePrivateDirs, inspectPermissions, privateRoot, safeJoin, PRIVATE_DIR_MODE } from "@/lib/paths";
import { removeAsset, storeAsset, MAX_ASSET_BYTES } from "@/documents/assets";
import { runChecks, diskUsage, sqliteHealth, workerHealth, costReport } from "@/lib/diagnostics";
import { kvSet } from "@/database/repositories/kv";
import { insertLlmRun } from "@/database/repositories/llm-runs";
import { writeConfig, settingsSchema } from "@/lib/config";
import nextConfig from "../next.config";
import { makePng } from "./helpers/png-fixture";

const settings = settingsSchema.parse({ company: { name: "GOMU", userName: "Madjid", email: "moi@gomu.fr" } });

function envWith(over: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  const env = getEnv();
  return {
    env,
    restore: () => {
      process.env = saved;
      resetEnvCache();
    },
  };
}

describe("Validation de la configuration au démarrage", () => {
  afterEach(() => resetEnvCache());

  it("production : secret ou mot de passe absent → démarrage refusé avec un message exploitable", () => {
    const { env, restore } = envWith({ NODE_ENV: "production", APP_SECRET: undefined, APP_PASSWORD: undefined, APP_URL: "https://ema.example.fr" });
    const issues = checkEnv(env);
    expect(issues.filter((i) => i.level === "error").map((i) => i.variable)).toEqual(expect.arrayContaining(["APP_SECRET", "APP_PASSWORD"]));
    expect(() => assertEnvUsable(env)).toThrow(/Configuration incomplète/);
    expect(() => assertEnvUsable(env)).toThrow(/APP_SECRET/);
    restore();
  });

  it("production : HTTP simple et WhatsApp partiel sont bloquants", () => {
    const { env, restore } = envWith({
      NODE_ENV: "production",
      APP_SECRET: "x".repeat(40),
      APP_PASSWORD: "motdepasse-long",
      APP_URL: "http://ema.example.fr",
      WHATSAPP_ACCESS_TOKEN: "token",
      WHATSAPP_PHONE_NUMBER_ID: undefined,
      WHATSAPP_VERIFY_TOKEN: undefined,
      WHATSAPP_APP_SECRET: undefined,
      WHATSAPP_APPROVER_PHONE: undefined,
    });
    const blocking = checkEnv(env).filter((i) => i.level === "error").map((i) => i.variable);
    expect(blocking).toEqual(expect.arrayContaining(["APP_URL", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_APPROVER_PHONE"]));
    restore();
  });

  it("développement : les mêmes manques ne sont que des avertissements", () => {
    const { env, restore } = envWith({ NODE_ENV: "development", APP_SECRET: undefined, APP_PASSWORD: undefined });
    expect(checkEnv(env).every((i) => i.level === "warning")).toBe(true);
    expect(() => assertEnvUsable(env)).not.toThrow();
    restore();
  });

  it("le fichier .env est chargé par les process hors Next (worker, doctor) sans écraser l'existant", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ema-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, ['# commentaire', 'EMA_TEST_ONE=valeur1', 'EMA_TEST_TWO="valeur deux"', 'invalide sans egal', 'lowercase=ignore', 'EMA_TEST_EXISTING=depuis-fichier'].join("\n"));
    process.env.EMA_TEST_EXISTING = "deja-defini";
    resetDotEnvForTests();
    const applied = loadDotEnv(file);
    expect(applied).toBe(2);
    expect(process.env.EMA_TEST_ONE).toBe("valeur1");
    expect(process.env.EMA_TEST_TWO).toBe("valeur deux");
    expect(process.env.EMA_TEST_EXISTING).toBe("deja-defini");
    expect(process.env.lowercase).toBeUndefined();
    delete process.env.EMA_TEST_ONE;
    delete process.env.EMA_TEST_TWO;
    delete process.env.EMA_TEST_EXISTING;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Authentification et limitation de débit", () => {
  beforeEach(() => clearRateLimits());
  afterEach(() => {
    clearRateLimits();
    resetEnvCache();
  });

  it("bloque après le nombre maximal de tentatives et libère après une réussite", () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.max; i++) expect(hitRateLimit("test").allowed).toBe(true);
    const blocked = hitRateLimit("test");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Toujours bloqué juste après
    expect(hitRateLimit("test").allowed).toBe(false);
    resetRateLimit("test");
    expect(hitRateLimit("test").allowed).toBe(true);
    // Fenêtre glissante : après expiration, les tentatives repartent
    clearRateLimits();
    const t0 = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT.max; i++) hitRateLimit("slide", LOGIN_RATE_LIMIT, t0);
    expect(hitRateLimit("slide", LOGIN_RATE_LIMIT, t0 + LOGIN_RATE_LIMIT.windowMs + 1000).allowed).toBe(true);
  });

  it("identifie le client par l'adresse transmise par Nginx", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }))).toBe("login:203.0.113.7");
    expect(clientKey(new Request("http://x"))).toBe("login:local");
  });

  it("mot de passe, cookie de session et falsification", () => {
    const { restore } = envWith({ NODE_ENV: "production", APP_SECRET: "s".repeat(40), APP_PASSWORD: "bon-mot-de-passe" });
    expect(verifyPassword("bon-mot-de-passe")).toBe(true);
    expect(verifyPassword("mauvais")).toBe(false);
    expect(verifyPassword("")).toBe(false);
    const value = createSessionValue();
    expect(isSessionValueValid(value)).toBe(true);
    expect(isSessionValueValid(`${value}x`)).toBe(false);
    expect(isSessionValueValid("9999999999.signature-bidon")).toBe(false);
    expect(isSessionValueValid(undefined)).toBe(false);
    // Session expirée
    expect(isSessionValueValid("1000000000.abc")).toBe(false);
    const opts = sessionCookieOptions();
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    restore();
  });
});

describe("Journalisation et messages d'erreur", () => {
  it("masque adresses email, numéros et champs sensibles", () => {
    expect(maskPersonalData("contact kevin.martin@abc-services.fr pour le devis")).toBe("contact k***@abc-services.fr pour le devis");
    expect(maskPersonalData("numéro 33612345678")).toContain("…");
    const redacted = redact({ access_token: "secret", refresh_token: "secret", api_key: "sk-ant", message: "écrire à jean@x.fr", nested: { password: "p", signature_path: "signatures/x.png", count: 3 } }) as Record<string, unknown>;
    expect(redacted.access_token).toBe("[redacted]");
    expect(redacted.api_key).toBe("[redacted]");
    expect(redacted.message).toBe("écrire à j***@x.fr");
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.password).toBe("[redacted]");
    expect(nested.signature_path).toBe("[redacted]");
    expect(nested.count).toBe(3);
  });

  it("les erreurs techniques ne sont jamais affichées telles quelles", () => {
    expect(isTechnicalMessage("SQLITE_CONSTRAINT: UNIQUE constraint failed")).toBe(true);
    expect(isTechnicalMessage("ENOENT: no such file")).toBe(true);
    expect(toEmaError(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed")).message).toBe(GENERIC_INTERNAL_MESSAGE);
    expect(toEmaError(new Error("Cannot read properties of undefined")).message).toBe(GENERIC_INTERNAL_MESSAGE);
    expect(toEmaError({ weird: true }).message).toBe(GENERIC_INTERNAL_MESSAGE);
    // Les messages métier restent intacts
    expect(toEmaError(new EmaError("VALIDATION", "Montant manquant")).message).toBe("Montant manquant");
    expect(toEmaError(new Error("Outlook n'est pas connecté")).message).toBe("Outlook n'est pas connecté");
  });
});

describe("Stockage privé et import de signature", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    ensurePrivateDirs();
  });
  afterEach(() => fs.rmSync(privateRoot(), { recursive: true, force: true }));

  it("enregistre un PNG valide sous un nom généré par le serveur, dans private/", () => {
    const stored = storeAsset("gomu83", "signature", makePng(300, 100), new Date("2026-09-16T10:00:00Z"));
    expect(stored.relativePath).toMatch(/^signatures\/gomu83-signature-\d{14}\.png$/);
    expect(stored.width).toBe(300);
    const file = safeJoin(privateRoot(), stored.relativePath);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file).subarray(0, 4).toString("hex")).toBe("89504e47");
    // Jamais dans public/
    expect(file.includes(`${path.sep}public${path.sep}`)).toBe(false);
    removeAsset(stored.relativePath);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuse tout ce qui n'est pas un PNG conforme", () => {
    expect(() => storeAsset("gomu83", "signature", Buffer.from("<svg onload=alert(1)>"))).toThrow(/PNG/);
    expect(() => storeAsset("gomu83", "stamp", Buffer.alloc(0))).toThrow(/vide/);
    expect(() => storeAsset("gomu83", "signature", Buffer.alloc(MAX_ASSET_BYTES + 1, 1))).toThrow(/volumineux/);
    expect(() => storeAsset("gomu83", "signature", makePng(5, 5))).toThrow(/Dimensions/);
    // Identifiant de société servant à construire le nom : aucune traversée possible
    expect(() => storeAsset("../../etc/passwd", "signature", makePng(100, 100))).toThrow(/invalide/);
    expect(() => storeAsset("a/b", "signature", makePng(100, 100))).toThrow(/invalide/);
    expect(db).toBeTruthy();
  });

  it("aucun chemin ne peut sortir du stockage privé", () => {
    expect(() => safeJoin(privateRoot(), "../../etc/passwd")).toThrow(/hors du dossier/);
    expect(() => safeJoin(privateRoot(), "/etc/passwd")).toThrow(/hors du dossier/);
    expect(() => safeJoin(privateRoot(), "documents/../../.env")).toThrow(/hors du dossier/);
    expect(safeJoin(privateRoot(), "documents/2026/09/f.pdf")).toContain(path.join("documents", "2026", "09"));
    removeAsset("../../.env"); // ignoré sans lever
    removeAsset(null);
  });

  it("les dossiers privés sont créés en droits propriétaire uniquement", () => {
    ensurePrivateDirs();
    const perms = inspectPermissions().filter((p) => p.exists && p.path.includes(path.basename(privateRoot())));
    expect(perms.length).toBeGreaterThan(0);
    for (const p of perms) expect(Number.parseInt(p.mode ?? "777", 8) & 0o077).toBe(0);
    expect(PRIVATE_DIR_MODE).toBe(0o700);
  });
});

describe("Diagnostic et santé", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    writeConfig("settings", settings);
  });
  afterEach(() => resetEnvCache());

  it("produit des contrôles lisibles sans jamais exposer de secret", () => {
    const { restore } = envWith({ ANTHROPIC_API_KEY: "sk-ant-secret-valeur", APP_SECRET: "s".repeat(40), APP_PASSWORD: "motdepasse-long" });
    kvSet("worker.heartbeat_at", new Date().toISOString(), db);
    const report = runChecks("0.8.0", new Date(), db);
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["configuration", "base de données", "worker", "espace disque", "permissions", "Anthropic", "Outlook", "WhatsApp", "sociétés"]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sk-ant-secret-valeur");
    expect(serialized).not.toContain("s".repeat(40));
    expect(["PASS", "WARN", "FAIL"]).toContain(report.status);
    restore();
  });

  it("intégrité SQLite, battement du worker et espace disque", () => {
    const health = sqliteHealth(db);
    expect(health.integrity).toBe("ok");
    expect(health.pendingMigrations).toEqual([]);
    kvSet("worker.heartbeat_at", new Date(Date.now() - 60 * 60_000).toISOString(), db);
    expect(workerHealth(new Date(), db).running).toBe(false);
    kvSet("worker.heartbeat_at", new Date().toISOString(), db);
    expect(workerHealth(new Date(), db).running).toBe(true);
    const disk = diskUsage();
    expect(disk.freeRatio).toBeGreaterThanOrEqual(0);
    expect(disk.freeRatio).toBeLessThanOrEqual(1);
  });

  it("compte la consommation Claude et estime le coût localement", () => {
    insertLlmRun({ operation: "analyze_email", model: "claude-opus-5", status: "ok", inputTokens: 1_000_000, outputTokens: 100_000, durationMs: 10 }, db);
    const report = costReport(7, db);
    expect(report.today.runs).toBe(1);
    expect(report.today.inputTokens).toBe(1_000_000);
    // 1M entrée × 5 + 0,1M sortie × 25 = 7,5
    expect(report.today.estimatedCost).toBeCloseTo(7.5, 3);
    expect(report.byOperation[0]?.operation).toBe("analyze_email");
  });
});

describe("Sécurité HTTP et sauvegarde", () => {
  it("les en-têtes de sécurité sont servis sur toutes les routes", async () => {
    const headers = await (nextConfig.headers as () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>)();
    const rule = headers[0]!;
    expect(rule.source).toBe("/:path*");
    const keys = rule.headers.map((h) => h.key);
    expect(keys).toEqual(expect.arrayContaining(["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Content-Security-Policy", "Permissions-Policy"]));
    const csp = rule.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
  });

  it("sauvegarde puis restauration : l'archive source n'est jamais écrasée et les données reviennent", () => {
    // Squelette d'installation EMA dans un dossier temporaire (scripts réels, node_modules partagé).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ema-install-"));
    fs.mkdirSync(path.join(root, "data"));
    fs.mkdirSync(path.join(root, "config"));
    fs.mkdirSync(path.join(root, "private", "documents"), { recursive: true });
    fs.mkdirSync(path.join(root, "scripts"));
    for (const f of ["backup.sh", "restore.sh", "db-snapshot.cjs"]) fs.copyFileSync(path.join("scripts", f), path.join(root, "scripts", f));
    fs.copyFileSync("package.json", path.join(root, "package.json"));
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.writeFileSync(path.join(root, ".env"), ["DATABASE_PATH=./data/ema.db", "PRIVATE_STORAGE_PATH=./private", "CONFIG_PATH=./config", ""].join("\n"));
    fs.writeFileSync(path.join(root, "config", "settings.json"), JSON.stringify({ version: 1 }));
    fs.writeFileSync(path.join(root, "private", "documents", "facture.pdf"), "%PDF-1.4 test");
    const source = new Database(path.join(root, "data", "ema.db"));
    source.pragma("journal_mode = WAL");
    source.exec("CREATE TABLE emails (id TEXT PRIMARY KEY)");
    source.prepare("INSERT INTO emails (id) VALUES ('e1')").run();
    source.close();

    execFileSync("bash", ["scripts/backup.sh"], { cwd: root, encoding: "utf8" });
    const archives = fs.readdirSync(path.join(root, "backups")).filter((f) => f.startsWith("ema-backup-"));
    expect(archives).toHaveLength(1);
    const archive = path.join(root, "backups", archives[0] as string);

    // Effacement puis restauration
    fs.rmSync(path.join(root, "private", "documents"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "config", "settings.json"));
    fs.rmSync(path.join(root, "data", "ema.db"));
    const out = execFileSync("bash", ["scripts/restore.sh", archive], { cwd: root, encoding: "utf8" });

    // L'archive restaurée existe toujours (la sauvegarde de sécurité ne l'écrase pas)
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.readdirSync(path.join(root, "backups")).some((f) => f.startsWith("pre-restore-"))).toBe(true);
    expect(out).toContain("Intégrité SQLite après restauration : ok");
    expect(fs.readFileSync(path.join(root, "private", "documents", "facture.pdf"), "utf8")).toBe("%PDF-1.4 test");
    expect(fs.existsSync(path.join(root, "config", "settings.json"))).toBe(true);
    const restored = new Database(path.join(root, "data", "ema.db"), { readonly: true });
    expect((restored.prepare("SELECT COUNT(*) AS c FROM emails").get() as { c: number }).c).toBe(1);
    restored.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("la copie de sauvegarde est cohérente, vérifiée et compte les lignes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ema-backup-"));
    const source = path.join(dir, "source.db");
    const target = path.join(dir, "copie.db");
    const db = new Database(source);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY); CREATE TABLE documents (id TEXT); CREATE TABLE actions (id TEXT); CREATE TABLE approvals (id TEXT); CREATE TABLE scheduled_followups (id TEXT); CREATE TABLE history (id TEXT); CREATE TABLE chat_messages (id TEXT);");
    db.prepare("INSERT INTO emails (id) VALUES ('e1'), ('e2')").run();
    db.close();
    const out = execFileSync("node", ["scripts/db-snapshot.cjs", source, target], { encoding: "utf8" });
    const parsed = JSON.parse(out) as { integrity: string; counts: Record<string, number> };
    expect(parsed.integrity).toBe("ok");
    expect(parsed.counts.emails).toBe(2);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
