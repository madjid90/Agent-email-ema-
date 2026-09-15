import { z } from "zod";
import type { ActionStatus, RiskLevel } from "@/database/types";

export type { ActionStatus, RiskLevel };

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** Types d'actions connus de l'Action Engine. */
export const actionTypeSchema = z.enum([
  "prepare_reply", // LOW — brouillon, aucun effet
  "reply_email", // MEDIUM — envoi dans le thread
  "forward_email", // MEDIUM
  "send_email", // MEDIUM
  "payment_request", // HIGH — email interne de demande de règlement
  "deposit_request", // HIGH — email interne de demande d'acompte
  "sign_document", // CRITICAL — signature + tampon + retour
  "send_followup", // MEDIUM — envoi d'une relance
  "archive", // LOW
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

/** Niveau de risque par défaut de chaque type (BUSINESS_RULES.md §3). */
export const DEFAULT_RISK: Record<ActionType, RiskLevel> = {
  prepare_reply: "LOW",
  archive: "LOW",
  reply_email: "MEDIUM",
  forward_email: "MEDIUM",
  send_email: "MEDIUM",
  send_followup: "MEDIUM",
  payment_request: "HIGH",
  deposit_request: "HIGH",
  sign_document: "CRITICAL",
};

/* Payloads typés --------------------------------------------------------- */

export const emailAddressList = z.array(z.string().email()).min(1);

export const replyEmailPayload = z.object({
  email_id: z.string(),
  body: z.string().min(1),
  reply_all: z.boolean().default(false),
  attachments: z.array(z.string()).default([]),
  /** Relance à l'origine de cette réponse (phase 7) : sert au message WhatsApp et au suivi. */
  followup_id: z.string().nullable().default(null),
  attempt: z.number().int().min(1).nullable().default(null),
});
export const forwardEmailPayload = z.object({
  email_id: z.string(),
  to: emailAddressList,
  comment: z.string().default(""),
});
export const sendEmailPayload = z.object({
  to: emailAddressList,
  subject: z.string().min(1),
  body: z.string().min(1),
  attachments: z.array(z.string()).default([]),
  thread_id: z.string().nullable().default(null),
});
export const paymentRequestPayload = z.object({
  email_id: z.string().nullable().default(null),
  to: emailAddressList,
  subject: z.string().min(1),
  body: z.string().min(1),
  supplier: z.string().nullable().default(null),
  amount: z.number().nullable().default(null),
  currency: z.string().default("EUR"),
  due_date: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
});
export const signDocumentPayload = z.object({
  email_id: z.string(),
  document_id: z.string(),
  company_id: z.string(),
  supplier_name: z.string().nullable().default(null),
  quote_number: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  amount_excl_tax: z.number().nullable().default(null),
  amount_incl_tax: z.number().nullable().default(null),
  currency: z.string().default("EUR"),
  valid_until: z.string().nullable().default(null),
  approval_text: z.string().min(1).default("Bon pour accord"),
  signature_required: z.boolean().default(true),
  stamp_required: z.boolean().default(false),
  /** Noms logiques uniquement : jamais de chemin, jamais de base64. */
  signature_label: z.string().nullable().default(null),
  stamp_label: z.string().nullable().default(null),
  signer_name: z.string().nullable().default(null),
  signer_title: z.string().nullable().default(null),
  placement_strategy: z.enum(["APPEND_APPROVAL_PAGE", "OVERLAY_LAST_PAGE"]).default("APPEND_APPROVAL_PAGE"),
  return_to_original_sender: z.boolean().default(true),
  reply_to: z.string().nullable().default(null),
  reply_subject: z.string().nullable().default(null),
  reply_body: z.string().min(1),
  quote_expired: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  /** Alias historique de approval_text. */
  mention: z.string().default("Bon pour accord"),
});
export const sendFollowupPayload = z.object({
  followup_id: z.string(),
  email_id: z.string(),
  body: z.string().min(1),
});
export const archivePayload = z.object({ document_id: z.string(), category: z.enum(["invoice", "quote", "signed", "other"]) });
export const prepareReplyPayload = z.object({ email_id: z.string(), body: z.string().min(1) });

export const ACTION_PAYLOAD_SCHEMAS = {
  prepare_reply: prepareReplyPayload,
  reply_email: replyEmailPayload,
  forward_email: forwardEmailPayload,
  send_email: sendEmailPayload,
  payment_request: paymentRequestPayload,
  deposit_request: paymentRequestPayload,
  sign_document: signDocumentPayload,
  send_followup: sendFollowupPayload,
  archive: archivePayload,
} as const satisfies Record<ActionType, z.ZodTypeAny>;

/** Entrée acceptée par proposeAction (valeurs par défaut optionnelles). */
export type ActionPayload<T extends ActionType> = z.input<(typeof ACTION_PAYLOAD_SCHEMAS)[T]>;
/** Payload validé, tel que reçu par un exécuteur. */
export type ActionPayloadOutput<T extends ActionType> = z.output<(typeof ACTION_PAYLOAD_SCHEMAS)[T]>;

export interface ProposeActionInput<T extends ActionType = ActionType> {
  type: T;
  title: string;
  payload: ActionPayload<T>;
  sourceEmailId?: string | null;
  companyId?: string | null;
  documentId?: string | null;
  /** Force un niveau de risque supérieur au défaut (jamais inférieur). */
  riskLevel?: RiskLevel;
  /** Demande explicite de validation (règle, analyse, paramètre). */
  requiresApproval?: boolean;
  actor?: "ema" | "user" | "worker" | "system";
}

export interface ExecutionResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface ActionExecutor<T extends ActionType = ActionType> {
  type: T;
  execute(payload: ActionPayloadOutput<T>, ctx: { actionId: string; companyId: string | null; documentId: string | null; sourceEmailId: string | null }): Promise<ExecutionResult>;
}

/** Transitions autorisées (ARCHITECTURE.md §5). */
export const ALLOWED_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  PROPOSED: ["WAITING_APPROVAL", "APPROVED", "REJECTED"],
  WAITING_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: ["EXECUTING", "REJECTED"],
  EXECUTING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  REJECTED: [],
  FAILED: ["APPROVED"], // nouvelle tentative explicite par l'utilisateur
};
