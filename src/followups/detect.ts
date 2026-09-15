import type { EmailRow, FollowupRow } from "@/database/types";

/**
 * Détection déterministe de l'état d'un thread à l'échéance d'une relance.
 * Aucune décision n'est déléguée au modèle : seules des règles explicites
 * (expéditeur, objet, motifs connus) distinguent une vraie réponse humaine
 * d'une réponse automatique. En cas de doute → AMBIGUOUS : jamais d'envoi
 * automatique, vérification humaine.
 */
export type ReplyClassification = "HUMAN_REPLY" | "AUTO_REPLY" | "AMBIGUOUS";

const AUTO_SUBJECT = /(absence du bureau|hors du bureau|out of office|automatic reply|auto[\s-]?reply|r[ée]ponse automatique|message automatique|accus[ée] de r[ée]ception|undeliverable|non remis|delivery status notification|mail delivery (failed|subsystem)|[ée]chec de remise|retour [àa] l'exp[ée]diteur|vacation|cong[ée]s annuels)/i;
const AUTO_BODY = /(je suis actuellement absent|actuellement en cong[ée]|absente? du bureau|i am (currently )?out of (the )?office|ce message est automatique|merci de ne pas r[ée]pondre|r[ée]ponse automatique|votre message a bien [ée]t[ée] re[çc]u et sera trait[ée]|n'a pas pu [êe]tre remis)/i;
const AUTO_SENDER = /^(no[-._]?reply|ne[-._]?pas[-._]?repondre|donotreply|mailer-daemon|postmaster|bounce|notification)s?@/i;

/** Un message entrant est-il une réponse humaine, une réponse automatique, ou douteux ? */
export function classifyReply(email: EmailRow): ReplyClassification {
  const subject = email.subject ?? "";
  const body = email.body_text ?? email.body_preview ?? "";
  const sender = email.sender_email ?? "";
  const autoSender = AUTO_SENDER.test(sender);
  const autoSubject = AUTO_SUBJECT.test(subject);
  const autoBody = AUTO_BODY.test(body);
  if (!autoSender && !autoSubject && !autoBody) return "HUMAN_REPLY";
  // Motif automatique détecté mais message long et personnalisé : on ne tranche pas.
  const substantive = body.trim().length > 400 && /\?/.test(body);
  if (substantive && !autoSender) return "AMBIGUOUS";
  return "AUTO_REPLY";
}

export interface ThreadCheck {
  /** Première réponse entrante postérieure à l'ancrage. */
  reply: EmailRow | null;
  classification: ReplyClassification | null;
  /** Message sortant plus récent que l'ancrage : la relance est obsolète. */
  newerOutbound: EmailRow | null;
  /** Messages examinés (postérieurs à l'ancrage). */
  consideredCount: number;
}

/**
 * Analyse d'un thread rechargé depuis Microsoft Graph.
 * Seuls les messages postérieurs à `watch_after` sont pris en compte : une
 * ancienne réponse du thread ne peut jamais annuler une relance récente.
 */
export function checkThread(thread: EmailRow[], followup: FollowupRow): ThreadCheck {
  const anchor = followup.watch_after ?? followup.created_at;
  const after = thread.filter((e) => e.received_at > anchor);
  const inbound = after.filter((e) => e.direction === "inbound");
  const outbound = after.filter((e) => e.direction === "outbound");
  const relevant = inbound.filter((e) => isRelevantSender(e, followup));
  const reply = relevant[0] ?? inbound[0] ?? null;
  return {
    reply,
    classification: reply ? classifyReply(reply) : null,
    newerOutbound: outbound.length ? (outbound[outbound.length - 1] as EmailRow) : null,
    consideredCount: after.length,
  };
}

/** Un participant pertinent : le destinataire suivi, ou tout tiers du thread si aucun destinataire n'est connu. */
function isRelevantSender(email: EmailRow, followup: FollowupRow): boolean {
  if (!followup.recipient) return true;
  const sender = (email.sender_email ?? "").toLowerCase();
  const recipient = followup.recipient.toLowerCase();
  if (sender === recipient) return true;
  const domain = recipient.split("@")[1];
  return Boolean(domain) && sender.endsWith(`@${domain}`);
}
