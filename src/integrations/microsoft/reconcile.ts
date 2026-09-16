import type { GraphClient } from "./graph-client";
import { listSentSince, findLatestSentInConversation } from "./mail";
import type { GraphMessage } from "./types";
import { addresses } from "./mail";
import { createLogger } from "@/lib/logger";

/**
 * Réconciliation Outlook (phase 8A) : après un envoi au résultat ambigu, on
 * cherche la trace réelle du message dans les éléments envoyés AVANT d'envisager
 * un nouvel envoi. Une correspondance faible n'est jamais acceptée.
 */
const log = createLogger("microsoft.reconcile");

export interface SentSearch {
  /** Réponse ou transfert : la conversation suffit à identifier l'envoi. */
  conversationId?: string | null;
  /** Nouvel email : objet et destinataires doivent correspondre tous les deux. */
  subject?: string | null;
  to?: string[];
  /** Fenêtre de recherche. */
  since: string;
  until?: string;
}

export type ReconcileVerdict = "sent" | "not_sent" | "unknown";

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  message: GraphMessage | null;
  detail: string;
}

/** Normalise un objet : casse, espaces et préfixes RE:/TR:/FW: ignorés. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .toLowerCase()
    .replace(/^\s*((re|ré|tr|fw|fwd)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameRecipient(message: GraphMessage, expected: string[]): boolean {
  if (expected.length === 0) return false;
  const actual = new Set(addresses(message.toRecipients).map((a) => a.toLowerCase()));
  return expected.some((e) => actual.has(e.toLowerCase()));
}

/**
 * Cherche l'envoi réel. `sent` seulement sur une correspondance forte :
 * même conversation, ou objet ET destinataire identiques dans la fenêtre.
 * Toute erreur de lecture Graph rend le verdict `unknown` : on ne conclut
 * jamais « non envoyé » parce qu'on n'a pas pu vérifier.
 */
export async function reconcileSentMessage(client: GraphClient, search: SentSearch): Promise<ReconcileResult> {
  try {
    if (search.conversationId) {
      const message = await findLatestSentInConversation(client, search.conversationId, search.since);
      if (message) return { verdict: "sent", message, detail: `message trouvé dans la conversation (${message.sentDateTime ?? "date inconnue"})` };
      return { verdict: "not_sent", message: null, detail: "aucun message envoyé dans cette conversation depuis la tentative" };
    }
    const wantedSubject = normalizeSubject(search.subject);
    const recipients = search.to ?? [];
    if (!wantedSubject || recipients.length === 0) {
      return { verdict: "unknown", message: null, detail: "critères insuffisants pour identifier l'envoi (objet ou destinataire manquant)" };
    }
    const candidates = await listSentSince(client, search.since, 25);
    const match = candidates.find((m) => normalizeSubject(m.subject) === wantedSubject && sameRecipient(m, recipients) && (!search.until || (m.sentDateTime ?? "") <= search.until));
    if (match) return { verdict: "sent", message: match, detail: `objet et destinataire identiques (${match.sentDateTime ?? "date inconnue"})` };
    const weak = candidates.some((m) => normalizeSubject(m.subject) === wantedSubject);
    if (weak) return { verdict: "unknown", message: null, detail: "objet identique mais destinataire différent : correspondance trop faible" };
    return { verdict: "not_sent", message: null, detail: "aucun envoi correspondant dans les éléments envoyés" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("reconciliation failed", { message });
    return { verdict: "unknown", message: null, detail: `vérification impossible : ${message}` };
  }
}
