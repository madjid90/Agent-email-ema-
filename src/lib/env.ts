import { z } from "zod";
import { EmaError } from "./errors";
import { loadDotEnv } from "./dotenv";

/**
 * Validation de l'environnement. Les valeurs ne sont jamais logguées.
 * Les secrets ne sortent jamais de ce module autrement que via getEnv()
 * appelé depuis src/integrations/* ou src/security/*.
 */
const optionalString = z.string().trim().optional().transform((v) => (v && v.length > 0 ? v : undefined));
/** Booléen d'environnement : absent ou vide = valeur par défaut ; "false"/"0"/"no"/"off" = faux. */
const optionalBool = (fallback: boolean) => z.string().trim().optional().transform((v) => (v === undefined || v.length === 0 ? fallback : !/^(false|0|no|off)$/i.test(v)));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().trim().default("claude-opus-5"),

  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  MICROSOFT_TENANT_ID: z.string().trim().default("common"),
  MICROSOFT_REDIRECT_URI: optionalString,

  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  /** Numéro autorisé à valider (format international, chiffres uniquement). */
  WHATSAPP_APPROVER_PHONE: optionalString,
  /** Ancien nom (phase 0), accepté comme alias de WHATSAPP_APPROVER_PHONE. */
  WHATSAPP_RECIPIENT_NUMBER: optionalString,
  WHATSAPP_API_VERSION: z.string().trim().default("v21.0"),
  /** Assistant conversationnel WhatsApp (phase 6). À false : seules les validations fonctionnent. */
  WHATSAPP_ASSISTANT_ENABLED: optionalBool(true),
  /** Template Meta utilisé pour les notifications proactives hors fenêtre de 24 h (phase 7). */
  WHATSAPP_FOLLOWUP_TEMPLATE_NAME: optionalString,
  WHATSAPP_FOLLOWUP_TEMPLATE_LANG: z.string().trim().default("fr"),

  APP_URL: z.string().trim().default("http://localhost:3000"),
  APP_SECRET: optionalString,
  /** Obsolète (comptes utilisateurs) : ignoré, conservé pour ne pas casser un .env existant. */
  APP_PASSWORD: optionalString,
  /** Création de comptes après le premier (chaque nouveau client crée le sien). */
  ALLOW_SIGNUP: optionalBool(false),
  /** Numéro WhatsApp Business d'EMA, affiché aux utilisateurs (lien « Ouvrir WhatsApp »), format E.164. */
  WHATSAPP_BUSINESS_NUMBER: optionalString,

  DATABASE_PATH: z.string().trim().default("./data/ema.db"),
  PRIVATE_STORAGE_PATH: z.string().trim().default("./private"),
  CONFIG_PATH: z.string().trim().default("./config"),

  WORKER_POLL_INTERVAL: z.coerce.number().int().min(15).default(120),
  // Synchronisation Outlook
  EMAIL_SYNC_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
  EMAIL_INITIAL_SYNC_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  ATTACHMENT_MAX_MB: z.coerce.number().min(0.1).max(150).default(15),
  /** Pièces jointes SORTANTES : encodées en base64 dans la requête Graph (pas d'upload session). */
  OUTGOING_ATTACHMENT_MAX_MB: z.coerce.number().min(0.1).max(25).default(3),
  /** Extraction PDF : au-delà, le worker d'extraction est arrêté. */
  PDF_EXTRACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
  /** Chiffrement des sauvegardes (scripts/backup.sh) : AES-256-GCM, clé dérivée par scrypt. */
  BACKUP_ENCRYPTION_PASSWORD: z.string().min(12, "12 caractères minimum").optional(),
  /** `true` uniquement si Nginx réécrit X-Forwarded-For (sinon l'en-tête n'est pas fiable). */
  TRUST_PROXY_HEADER: optionalBool(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  // Worker, migrations, doctor : Next.js ne charge pas .env pour eux.
  loadDotEnv();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Environnement invalide : ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Réinitialise le cache (tests uniquement). */
export function resetEnvCache(): void {
  cached = null;
}

export interface EnvIssue {
  variable: string;
  message: string;
  level: "error" | "warning";
}

/**
 * Contrôle de configuration au démarrage (phase 8). En production, une variable
 * obligatoire manquante empêche le démarrage : EMA ne tourne jamais dans un état
 * partiellement sécurisé. Les variables optionnelles remontent en avertissement.
 */
export function checkEnv(env: Env = getEnv()): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const production = env.NODE_ENV === "production";
  const err = (variable: string, message: string) => issues.push({ variable, message, level: production ? "error" : "warning" });
  const warn = (variable: string, message: string) => issues.push({ variable, message, level: "warning" });

  if (!env.APP_SECRET) err("APP_SECRET", "Clé de chiffrement et de signature absente (cookies de session, tokens OAuth)");
  else if (env.APP_SECRET.length < 32) err("APP_SECRET", "Clé trop courte : 32 caractères minimum");
  if (env.APP_PASSWORD) warn("APP_PASSWORD", "Variable obsolète : l'accès se fait désormais par compte utilisateur (email + mot de passe)");
  if (production && !env.APP_URL.startsWith("https://")) err("APP_URL", "HTTPS obligatoire en production");

  const whatsappPartial = Boolean(env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_VERIFY_TOKEN);
  if (whatsappPartial) {
    if (!env.WHATSAPP_ACCESS_TOKEN) err("WHATSAPP_ACCESS_TOKEN", "WhatsApp partiellement configuré");
    if (!env.WHATSAPP_PHONE_NUMBER_ID) err("WHATSAPP_PHONE_NUMBER_ID", "WhatsApp partiellement configuré");
    if (!env.WHATSAPP_VERIFY_TOKEN) err("WHATSAPP_VERIFY_TOKEN", "Jeton de vérification du webhook absent");
    if (!env.WHATSAPP_APP_SECRET) err("WHATSAPP_APP_SECRET", "Signature des webhooks non vérifiable : webhooks refusés en production");
    if (!env.WHATSAPP_BUSINESS_NUMBER) warn("WHATSAPP_BUSINESS_NUMBER", "Numéro WhatsApp d'EMA absent : le bouton « Ouvrir WhatsApp » ne pourra pas être affiché aux utilisateurs");
  } else {
    warn("WHATSAPP_ACCESS_TOKEN", "WhatsApp non configuré : les validations se font uniquement dans l'interface");
  }
  if (!env.ANTHROPIC_API_KEY) warn("ANTHROPIC_API_KEY", "Analyse Claude indisponible tant que la clé n'est pas renseignée");
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) warn("MICROSOFT_CLIENT_ID", "Connexion Outlook impossible tant que l'App Registration n'est pas renseignée");
  else if (!env.MICROSOFT_REDIRECT_URI) warn("MICROSOFT_REDIRECT_URI", "URL de redirection OAuth absente");
  return issues;
}

/** Lève si la configuration interdit un démarrage sûr (production). */
export function assertEnvUsable(env: Env = getEnv()): void {
  const blocking = checkEnv(env).filter((i) => i.level === "error");
  if (blocking.length === 0) return;
  const detail = blocking.map((i) => `${i.variable} : ${i.message}`).join(" | ");
  throw new EmaError("CONFIG", `Configuration incomplète, EMA ne peut pas démarrer — ${detail}. Corriger .env (voir .env.example et docs/deployment.md), puis redémarrer.`);
}

/** Numéro autorisé à valider, normalisé en chiffres (ex. 33612345678), ou null. */
export function getApproverPhone(): string | null {
  const env = getEnv();
  const raw = env.WHATSAPP_APPROVER_PHONE ?? env.WHATSAPP_RECIPIENT_NUMBER;
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/** Indique quelles intégrations sont configurées, sans exposer les valeurs. */
export function getConfiguredIntegrations(): {
  anthropic: boolean;
  microsoft: boolean;
  whatsapp: boolean;
  appSecret: boolean;
  appPassword: boolean;
} {
  const env = getEnv();
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_REDIRECT_URI),
    whatsapp: Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_VERIFY_TOKEN),
    appSecret: Boolean(env.APP_SECRET && env.APP_SECRET.length >= 32),
    appPassword: Boolean(env.APP_PASSWORD),
  };
}
