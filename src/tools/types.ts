import { z } from "zod";
import { EmaError } from "@/lib/errors";
import type { RiskLevel } from "@/database/types";
import type { Db } from "@/database/connection";
import type { Settings, Rule, Company, Contact } from "@/lib/config";

/**
 * Contexte passé aux tools. Il ne contient JAMAIS de secret : les intégrations
 * (src/integrations/*) lisent l'environnement elles-mêmes.
 */
export interface ToolContext {
  db: Db;
  settings: Settings;
  rules: Rule[];
  companies: Company[];
  contacts: Contact[];
  /** Mode d'exécution : détermine les tools exposés à Claude. */
  mode: ToolMode;
  /** Email en cours de traitement (mode analyze / followup). */
  currentEmailId?: string | null;
  /**
   * Utilisateur pour lequel les tools s'exécutent. Fixé par le serveur
   * (session web, numéro WhatsApp identifié, email en cours d'analyse) : le
   * modèle ne peut ni le choisir ni le changer. Chaque tool ne lit et n'écrit
   * que les données de cet utilisateur et n'utilise que SA connexion Microsoft.
   */
  userId?: string | null;
}

/**
 * Garde d'isolation : une ligne appartenant à un autre utilisateur est traitée
 * comme inexistante (NOT_FOUND), jamais révélée. Une ligne sans propriétaire
 * (données antérieures à 010_users) reste accessible à un contexte non scopé.
 */
export function assertOwned(row: { user_id: string | null } | undefined | null, ctx: { userId?: string | null }, what: string): void {
  if (!row) throw new EmaError("NOT_FOUND", `${what} introuvable`);
  if (ctx.userId && row.user_id !== ctx.userId) throw new EmaError("NOT_FOUND", `${what} introuvable`);
}

export type ToolMode = "analyze" | "chat" | "followup" | "internal";

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  input: I;
  output: O;
  /** Modes dans lesquels le tool est exposé à Claude. `internal` = jamais exposé. */
  modes: ToolMode[];
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<z.infer<O>>;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(def.name)) throw new Error(`Nom de tool invalide : ${def.name}`);
  return def;
}

export interface ToolErrorResult {
  ok: false;
  error: { code: string; message: string };
}

export type ToolResult<T> = { ok: true; data: T } | ToolErrorResult;

/* Schémas partagés ------------------------------------------------------ */

export const emailSummarySchema = z.object({
  email_id: z.string(),
  thread_id: z.string().nullable(),
  from: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
  to: z.array(z.string()),
  subject: z.string(),
  received_at: z.string(),
  preview: z.string(),
  has_attachments: z.boolean(),
  direction: z.enum(["inbound", "outbound"]),
});
export type EmailSummary = z.infer<typeof emailSummarySchema>;

export const emailFullSchema = emailSummarySchema.extend({
  body: z.string(),
  attachments: z.array(z.object({ attachment_id: z.string(), name: z.string(), mime: z.string(), size: z.number() })),
});
export type EmailFull = z.infer<typeof emailFullSchema>;

export const actionRefSchema = z.object({ action_id: z.string(), status: z.string(), requires_approval: z.boolean() });
