import { z } from "zod";
import { emailCategorySchema } from "@/lib/config";

export { emailCategorySchema };

export const urgencySchema = z.enum(["low", "medium", "high", "critical"]);
export type Urgency = z.infer<typeof urgencySchema>;

export const recommendedActionSchema = z.enum([
  "reply",
  "forward",
  "payment_request",
  "deposit_request",
  "sign_document",
  "schedule_followup",
  "archive",
  "none",
]);
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;

export const amountSchema = z.object({
  value: z.number(),
  currency: z.string().default("EUR"),
  taxMode: z.enum(["HT", "TTC", "unknown"]).default("unknown"),
});

/**
 * Structure obligatoire produite par Claude pour chaque email.
 * Règle : ne jamais inventer une donnée absente → null.
 */
export const emailAnalysisSchema = z.object({
  category: emailCategorySchema,
  urgency: urgencySchema,
  summary: z.string().min(1).max(1200),
  company: z.string().nullable().describe("id de la société dans config/companies.json, ou null"),
  sender: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    organization: z.string().nullable().optional(),
  }),
  requested_action: z.string().nullable(),
  amount: amountSchema.nullable(),
  due_date: z.string().nullable().describe("Date ISO (YYYY-MM-DD) ou null"),
  recommended_action: recommendedActionSchema,
  confidence: z.number().min(0).max(1),
  requires_approval: z.boolean(),
  proposed_reply: z.string().nullable().optional().describe("Brouillon de réponse si recommended_action = reply"),
  forward_to: z.string().nullable().optional().describe("Destinataire si recommended_action = forward (issu des règles)"),
  injection_suspected: z.boolean().default(false),
});
export type EmailAnalysis = z.infer<typeof emailAnalysisSchema>;
