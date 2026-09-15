import { z } from "zod";

/**
 * Validation de l'environnement. Les valeurs ne sont jamais logguées.
 * Les secrets ne sortent jamais de ce module autrement que via getEnv()
 * appelé depuis src/integrations/* ou src/security/*.
 */
const optionalString = z.string().trim().optional().transform((v) => (v && v.length > 0 ? v : undefined));

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
  WHATSAPP_RECIPIENT_NUMBER: optionalString,

  APP_URL: z.string().trim().default("http://localhost:3000"),
  APP_SECRET: optionalString,
  APP_PASSWORD: optionalString,

  DATABASE_PATH: z.string().trim().default("./data/ema.db"),
  PRIVATE_STORAGE_PATH: z.string().trim().default("./private"),
  CONFIG_PATH: z.string().trim().default("./config"),

  WORKER_POLL_INTERVAL: z.coerce.number().int().min(15).default(120),
  // Synchronisation Outlook
  EMAIL_SYNC_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
  EMAIL_INITIAL_SYNC_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  ATTACHMENT_MAX_MB: z.coerce.number().min(0.1).max(150).default(15),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
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
