import { z } from "zod";
import { defineTool, assertOwned } from "../types";
import * as followupsRepo from "@/database/repositories/followups";
import * as emailsRepo from "@/database/repositories/emails";
import { EmaError } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";
import { WEEKDAYS } from "@/followups/schedule";
import { cancelFollowup as cancelFollowupService, completeReminder, postponeFollowup, processFollowup, scheduleFollowup as scheduleFollowupService } from "@/followups/service";

/**
 * Tools relances. Le modèle n'exprime qu'une INTENTION temporelle : la date
 * finale est toujours calculée côté serveur (fuseau du client, heure par
 * défaut configurée). Aucune relance n'est envoyée par ces tools : à l'échéance,
 * EMA vérifie Outlook puis crée une action `reply_email` soumise à validation.
 */
const whenSchema = z
  .object({
    in_days: z.number().int().min(0).max(365).nullable().default(null).describe("Dans N jours (« demain » = 1, « dans 3 jours » = 3)"),
    date: z.string().nullable().default(null).describe("Date explicite AAAA-MM-JJ"),
    weekday: z.enum(WEEKDAYS).nullable().default(null).describe("Prochain jour de la semaine"),
    time: z.string().nullable().default(null).describe("Heure locale HH:MM ; sinon l'heure par défaut configurée"),
  })
  .describe("Intention temporelle ; la date finale est calculée par le serveur");

const followupSummary = z.object({
  followup_id: z.string(),
  kind: z.string(),
  status: z.string(),
  recipient: z.string().nullable(),
  reason: z.string(),
  title: z.string().nullable(),
  execute_at: z.string(),
  attempts: z.number(),
  max_attempts: z.number(),
  email_id: z.string().nullable(),
  thread_id: z.string(),
  action_id: z.string().nullable(),
  last_reply_email_id: z.string().nullable(),
});

export const scheduleFollowup = defineTool({
  name: "schedule_followup",
  description: "Programme une relance sur un thread (ou un rappel interne sans email) à une échéance exprimée en langage naturel. Aucun email n'est envoyé : à l'échéance EMA vérifie Outlook et, sans réponse, prépare une relance soumise à validation.",
  riskLevel: "LOW",
  modes: ["analyze", "chat", "followup"],
  input: z.object({
    email_id: z.string().nullable().default(null).describe("Email du thread à surveiller (obligatoire pour une relance externe)"),
    reason: z.string().min(1).describe("Ce qui est attendu (ex. « retour sur le devis »)"),
    when: whenSchema.nullable().default(null),
    kind: z.enum(["EXTERNAL_FOLLOWUP", "INTERNAL_REMINDER"]).default("EXTERNAL_FOLLOWUP"),
    title: z.string().nullable().default(null).describe("Titre du rappel interne"),
    document_id: z.string().nullable().default(null),
    company_id: z.string().nullable().default(null),
  }),
  output: z.object({ followup_id: z.string(), execute_at: z.string(), execute_at_local: z.string(), kind: z.string(), recipient: z.string().nullable() }),
  handler: async (input, ctx) => {
    if (input.kind === "EXTERNAL_FOLLOWUP" && !input.email_id) throw new EmaError("VALIDATION", "Une relance externe doit être rattachée à un email");
    if (input.email_id) assertOwned(emailsRepo.getEmail(input.email_id, ctx.db), ctx, `Email ${input.email_id}`);
    const f = scheduleFollowupService(
      {
        emailId: input.email_id,
        reason: input.reason,
        when: input.when,
        kind: input.kind,
        title: input.title,
        documentId: input.document_id,
        companyId: input.company_id,
        createdBy: ctx.mode === "chat" ? "user" : "ema",
      },
      { db: ctx.db, settings: ctx.settings, userId: ctx.userId },
    );
    return { followup_id: f.id, execute_at: f.execute_at, execute_at_local: formatDateTime(f.execute_at, ctx.settings.company.timezone), kind: f.kind, recipient: f.recipient };
  },
});

export const listFollowups = defineTool({
  name: "list_followups",
  description: "Liste les relances et rappels : à venir, du jour, en attente de validation, terminés. Sert à répondre « qui dois-je relancer aujourd'hui ? ».",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({
    scope: z.enum(["today", "upcoming", "pending_approval", "needs_attention", "all"]).default("today"),
    kind: z.enum(["EXTERNAL_FOLLOWUP", "INTERNAL_REMINDER"]).nullable().default(null),
    max: z.number().int().min(1).max(50).default(20),
  }),
  output: z.array(followupSummary),
  handler: async (input, ctx) => {
    const now = new Date();
    const endOfDay = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
    const base = { kind: input.kind ?? undefined, limit: input.max, userId: ctx.userId ?? undefined };
    const rows =
      input.scope === "today"
        ? followupsRepo.listFollowups({ ...base, status: ["SCHEDULED", "CHECK_FAILED", "REMINDED"], dueBefore: endOfDay }, ctx.db)
        : input.scope === "upcoming"
          ? followupsRepo.listFollowups({ ...base, status: ["SCHEDULED", "CHECK_FAILED"] }, ctx.db)
          : input.scope === "pending_approval"
            ? followupsRepo.listFollowups({ ...base, status: "WAITING_APPROVAL" }, ctx.db)
            : input.scope === "needs_attention"
              ? followupsRepo.listFollowups({ ...base, status: ["MAX_ATTEMPTS_REACHED", "REVIEW_REQUIRED", "FAILED"] }, ctx.db)
              : followupsRepo.listFollowups(base, ctx.db);
    return rows.map((f) => ({
      followup_id: f.id,
      kind: f.kind,
      status: f.status,
      recipient: f.recipient,
      reason: f.reason,
      title: f.title,
      execute_at: formatDateTime(f.execute_at, ctx.settings.company.timezone),
      attempts: f.attempts,
      max_attempts: f.max_attempts,
      email_id: f.email_id,
      thread_id: f.thread_id,
      action_id: f.generated_action_id,
      last_reply_email_id: f.last_reply_email_id,
    }));
  },
});

export const postponeFollowupTool = defineTool({
  name: "postpone_followup",
  description: "Reporte une relance ou un rappel à une nouvelle échéance (« reporte-la à vendredi »). La relance existante est conservée : aucun doublon n'est créé.",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({ followup_id: z.string(), when: whenSchema.nullable().default(null) }),
  output: z.object({ followup_id: z.string(), status: z.string(), execute_at: z.string() }),
  handler: async (input, ctx) => {
    assertOwned(followupsRepo.getFollowup(input.followup_id, ctx.db), ctx, `Relance ${input.followup_id}`);
    const f = postponeFollowup(input.followup_id, input.when, { db: ctx.db, settings: ctx.settings, userId: ctx.userId, actor: ctx.mode === "chat" ? "user" : "ema" });
    return { followup_id: f.id, status: f.status, execute_at: formatDateTime(f.execute_at, ctx.settings.company.timezone) };
  },
});

export const cancelFollowup = defineTool({
  name: "cancel_followup",
  description: "Annule une relance ou un rappel programmé. Aucune action future ne sera créée.",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({ followup_id: z.string(), reason: z.string().default("Annulée par l'utilisateur") }),
  output: z.object({ followup_id: z.string(), status: z.string() }),
  handler: async (input, ctx) => {
    assertOwned(followupsRepo.getFollowup(input.followup_id, ctx.db), ctx, `Relance ${input.followup_id}`);
    const f = cancelFollowupService(input.followup_id, input.reason, { db: ctx.db, settings: ctx.settings, userId: ctx.userId, actor: ctx.mode === "chat" ? "user" : "ema" });
    return { followup_id: f.id, status: f.status };
  },
});

export const completeFollowup = defineTool({
  name: "complete_reminder",
  description: "Marque un rappel interne comme traité.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ followup_id: z.string() }),
  output: z.object({ followup_id: z.string(), status: z.string() }),
  handler: async (input, ctx) => {
    assertOwned(followupsRepo.getFollowup(input.followup_id, ctx.db), ctx, `Relance ${input.followup_id}`);
    const f = completeReminder(input.followup_id, { db: ctx.db, settings: ctx.settings, userId: ctx.userId, actor: ctx.mode === "chat" ? "user" : "ema" });
    return { followup_id: f.id, status: f.status };
  },
});

export const prepareFollowupNow = defineTool({
  name: "prepare_followup_now",
  description: "Traite immédiatement une relance programmée : EMA vérifie d'abord le thread Outlook, puis, si aucune réponse n'est arrivée, prépare la relance sous forme d'action soumise à validation. N'envoie jamais d'email.",
  riskLevel: "MEDIUM",
  modes: ["chat", "followup"],
  input: z.object({ followup_id: z.string() }),
  output: z.object({ followup_id: z.string(), outcome: z.string(), action_id: z.string().nullable(), status: z.string(), message: z.string() }),
  handler: async (input, ctx) => {
    assertOwned(followupsRepo.getFollowup(input.followup_id, ctx.db), ctx, `Relance ${input.followup_id}`);
    const r = await processFollowup(input.followup_id, { db: ctx.db, settings: ctx.settings, rules: ctx.rules, companies: ctx.companies, contacts: ctx.contacts, userId: ctx.userId });
    const after = followupsRepo.getFollowup(input.followup_id, ctx.db);
    return { followup_id: r.followupId, outcome: r.outcome, action_id: r.actionId, status: after?.status ?? "?", message: r.message };
  },
});

export const checkReplyReceived = defineTool({
  name: "check_reply_received",
  description: "Vérifie si une réponse entrante est arrivée sur un thread depuis une date (données locales).",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({ thread_id: z.string(), since: z.string() }),
  output: z.object({ replied: z.boolean(), reply_email_id: z.string().nullable() }),
  handler: async (input, ctx) => {
    const reply = emailsRepo.listThread(input.thread_id, ctx.db, ctx.userId ?? undefined).find((e) => e.direction === "inbound" && e.received_at > input.since);
    return { replied: Boolean(reply), reply_email_id: reply?.id ?? null };
  },
});

export const followupTools = [scheduleFollowup, listFollowups, postponeFollowupTool, cancelFollowup, completeFollowup, prepareFollowupNow, checkReplyReceived];
