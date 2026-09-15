import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configRoot, ensureDir } from "./paths";
import { EmaError } from "./errors";
import { createLogger } from "./logger";

const log = createLogger("config");

/* ------------------------------------------------------------------ */
/* Schémas                                                             */
/* ------------------------------------------------------------------ */

export const settingsSchema = z.object({
  company: z.object({
    name: z.string().default(""),
    userName: z.string().default(""),
    email: z.string().default(""),
    language: z.enum(["fr", "en"]).default("fr"),
    timezone: z.string().default("Europe/Paris"),
  }),
  mailbox: z
    .object({
      pollIntervalSeconds: z.number().int().min(15).default(120),
      maxEmailsPerScan: z.number().int().min(1).max(200).default(25),
      ignoreFolders: z.array(z.string()).default([]),
    })
    .default({ pollIntervalSeconds: 120, maxEmailsPerScan: 25, ignoreFolders: [] }),
  agent: z
    .object({
      signatureText: z.string().default(""),
      tone: z.string().default("professionnel"),
      autoReplyEnabled: z.boolean().default(false),
      defaultFollowupDelayDays: z.number().int().min(1).max(60).default(5),
    })
    .default({ signatureText: "", tone: "professionnel", autoReplyEnabled: false, defaultFollowupDelayDays: 5 }),
  approvals: z
    .object({
      channel: z.enum(["whatsapp", "ui"]).default("whatsapp"),
      expireAfterHours: z.number().int().min(1).max(720).default(48),
    })
    .default({ channel: "whatsapp", expireAfterHours: 48 }),
  analysis: z
    .object({
      /** ≥ reliable : analyse fiable ; entre review et reliable : avertissement ; < review : validation humaine. */
      reliableThreshold: z.number().min(0).max(1).default(0.85),
      reviewThreshold: z.number().min(0).max(1).default(0.6),
      effort: z.enum(["low", "medium", "high"]).default("medium"),
      maxThreadMessages: z.number().int().min(1).max(20).default(8),
    })
    .default({ reliableThreshold: 0.85, reviewThreshold: 0.6, effort: "medium", maxThreadMessages: 8 }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const EMAIL_CATEGORIES = [
  "INVOICE",
  "QUOTE",
  "PAYMENT_REQUEST",
  "DEPOSIT_REQUEST",
  "SUPPLIER_FOLLOWUP",
  "ADMIN_REQUEST",
  "TECHNICAL_REQUEST",
  "INFORMATION",
  "URGENT",
  "DOCUMENT_TO_SIGN",
  "FOLLOWUP_REQUIRED",
  "OTHER",
] as const;
export const emailCategorySchema = z.enum(EMAIL_CATEGORIES);
export type EmailCategory = z.infer<typeof emailCategorySchema>;

/** Anciennes valeurs (phase 0, minuscules) acceptées dans config/rules.json. */
const LEGACY_CATEGORIES: Record<string, EmailCategory> = {
  invoice: "INVOICE",
  quote: "QUOTE",
  payment: "PAYMENT_REQUEST",
  deposit: "DEPOSIT_REQUEST",
  reminder: "SUPPLIER_FOLLOWUP",
  administrative: "ADMIN_REQUEST",
  technical: "TECHNICAL_REQUEST",
  information: "INFORMATION",
  urgent: "URGENT",
  document_to_sign: "DOCUMENT_TO_SIGN",
  to_forward: "OTHER",
  needs_reply: "FOLLOWUP_REQUIRED",
  other: "OTHER",
};
const ruleCategorySchema = z.preprocess((v) => (typeof v === "string" && v in LEGACY_CATEGORIES ? LEGACY_CATEGORIES[v] : v), emailCategorySchema);

export const ruleConditionSchema = z.object({
  category: ruleCategorySchema.optional(),
  supplierContains: z.string().optional(),
  senderDomain: z.string().optional(),
  senderEmail: z.string().optional(),
  subjectContains: z.string().optional(),
  companyId: z.string().optional(),
  minAmount: z.number().optional(),
});

export const ruleEffectSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("forward"), to: z.string().email(), requiresApproval: z.boolean().default(true) }),
  z.object({ action: z.literal("reply_template"), template: z.string(), requiresApproval: z.boolean().default(true) }),
  z.object({ action: z.literal("require_approval") }),
  z.object({ action: z.literal("notify"), message: z.string().optional() }),
  z.object({ action: z.literal("ignore") }),
]);

export const ruleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  when: ruleConditionSchema,
  then: ruleEffectSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const rulesFileSchema = z.object({ version: z.number().int().default(1), rules: z.array(ruleSchema).default([]) });
export type RulesFile = z.infer<typeof rulesFileSchema>;

export const contactSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().default(""),
  internal: z.boolean().default(true),
});
export type Contact = z.infer<typeof contactSchema>;
export const contactsFileSchema = z.object({ version: z.number().int().default(1), contacts: z.array(contactSchema).default([]) });
export type ContactsFile = z.infer<typeof contactsFileSchema>;

export const companySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  legalForm: z.string().default(""),
  siret: z.string().default(""),
  address: z.string().default(""),
  signatory: z.object({ name: z.string().default(""), title: z.string().default("") }),
  // Chemins relatifs à private/ ; jamais transmis à Claude.
  signaturePath: z.string().nullable().default(null),
  stampPath: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
});
export type Company = z.infer<typeof companySchema>;
export const companiesFileSchema = z.object({ version: z.number().int().default(1), companies: z.array(companySchema).default([]) });
export type CompaniesFile = z.infer<typeof companiesFileSchema>;

/* ------------------------------------------------------------------ */
/* Lecture / écriture                                                  */
/* ------------------------------------------------------------------ */

type ConfigName = "settings" | "rules" | "contacts" | "companies";

const SCHEMAS = {
  settings: settingsSchema,
  rules: rulesFileSchema,
  contacts: contactsFileSchema,
  companies: companiesFileSchema,
} as const;

type ConfigTypeOf<N extends ConfigName> = z.infer<(typeof SCHEMAS)[N]>;

const FORBIDDEN_KEYS = /token|secret|api_key|apikey|password/i;

function assertNoSecrets(value: unknown, trail: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, [...trail, String(i)]));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(k)) {
        throw new EmaError("CONFIG", `Clé interdite dans la configuration : ${[...trail, k].join(".")} (les secrets vont dans .env)`);
      }
      assertNoSecrets(v, [...trail, k]);
    }
  }
}

function filePath(name: ConfigName): string {
  return path.join(configRoot(), `${name}.json`);
}

function examplePath(name: ConfigName): string {
  return path.join(configRoot(), `${name}.example.json`);
}

/** Crée config/<name>.json depuis l'exemple s'il n'existe pas. */
export function ensureConfigFile(name: ConfigName): void {
  const target = filePath(name);
  if (fs.existsSync(target)) return;
  ensureDir(configRoot());
  const example = examplePath(name);
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, target);
    log.info("config file created from example", { name });
  } else {
    const empty = SCHEMAS[name].parse(name === "settings" ? { company: {} } : {});
    fs.writeFileSync(target, JSON.stringify(empty, null, 2) + "\n", "utf8");
    log.info("config file created empty", { name });
  }
}

export function readConfig<N extends ConfigName>(name: N): ConfigTypeOf<N> {
  ensureConfigFile(name);
  const raw = fs.readFileSync(filePath(name), "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new EmaError("CONFIG", `config/${name}.json n'est pas un JSON valide`, { cause: err });
  }
  const parsed = SCHEMAS[name].safeParse(json);
  if (!parsed.success) {
    throw new EmaError("CONFIG", `config/${name}.json invalide`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data as ConfigTypeOf<N>;
}

export function writeConfig<N extends ConfigName>(name: N, value: unknown): ConfigTypeOf<N> {
  // Vérifié sur la valeur brute : zod supprime les clés inconnues, un secret glissé
  // dans une clé non prévue doit quand même être refusé.
  assertNoSecrets(value);
  const parsed = SCHEMAS[name].safeParse(value);
  if (!parsed.success) {
    throw new EmaError("VALIDATION", `Configuration ${name} invalide`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  ensureDir(configRoot());
  const target = filePath(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
  return parsed.data as ConfigTypeOf<N>;
}

export function getSettings(): Settings {
  return readConfig("settings");
}
export function getRules(): Rule[] {
  return readConfig("rules").rules;
}
export function getContacts(): Contact[] {
  return readConfig("contacts").contacts;
}
export function getCompanies(): Company[] {
  return readConfig("companies").companies;
}

export function findCompany(id: string): Company | undefined {
  return getCompanies().find((c) => c.id === id);
}
