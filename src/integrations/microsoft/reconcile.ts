import type { GraphClient } from "./graph-client";
import { listSentSince, findLatestSentInConversation } from "./mail";
import { listAttachments } from "./attachments";
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
  /** Réponse, transfert ou envoi signé : premier filtre, jamais une preuve à lui seul. */
  conversationId?: string | null;
  /** Nouvel email : objet et destinataires doivent correspondre tous les deux. */
  subject?: string | null;
  to?: string[];
  /** Extrait du corps réellement envoyé (comparaison normalisée, casse ignorée). */
  bodyContains?: string | null;
  /** Nom de la pièce jointe attendue (document signé) : vérifié via Mail.Read. */
  attachmentName?: string | null;
  /** `true` si l'envoi devait comporter au moins une pièce jointe. */
  expectAttachment?: boolean;
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
  const actual = new Set([...addresses(message.toRecipients), ...addresses(message.ccRecipients)].map((a) => a.toLowerCase()));
  return expected.some((e) => actual.has(e.toLowerCase()));
}

/** Texte comparable : casse, accents typographiques et espaces normalisés. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, "'").replace(/\s+/g, " ").trim();
}

/** Extrait significatif du corps attendu (assez long pour discriminer, assez court pour résister au formatage). */
function bodyFingerprint(body: string): string | null {
  const clean = normalizeText(body);
  if (clean.length < 20) return null;
  return clean.slice(0, 80);
}

interface Confirmation {
  confirmed: boolean;
  /** Ce qui a permis (ou empêché) de conclure. */
  detail: string;
}

/**
 * Vérifications supplémentaires sur un message trouvé dans la bonne conversation.
 * Une conversation ne prouve rien à elle seule : un message plus récent d'un
 * autre envoi, un transfert vers un autre destinataire ou une réponse partie
 * avant la tentative y figurent aussi. Chaque critère disponible doit
 * correspondre ; sinon la correspondance est rejetée (verdict `unknown`).
 */
async function confirmMessage(client: GraphClient, message: GraphMessage, search: SentSearch): Promise<Confirmation> {
  const checks: string[] = [];

  const recipients = search.to ?? [];
  if (recipients.length > 0) {
    if (!sameRecipient(message, recipients)) return { confirmed: false, detail: `destinataire différent de ${recipients.join(", ")}` };
    checks.push("destinataire identique");
  }

  const wantedSubject = normalizeSubject(search.subject);
  if (wantedSubject) {
    if (normalizeSubject(message.subject) !== wantedSubject) return { confirmed: false, detail: "objet différent" };
    checks.push("objet identique");
  }

  const fingerprint = search.bodyContains ? bodyFingerprint(search.bodyContains) : null;
  if (fingerprint) {
    const haystack = normalizeText(`${message.body?.content ?? ""} ${message.bodyPreview ?? ""}`);
    if (!haystack.includes(fingerprint)) return { confirmed: false, detail: "contenu du message différent de celui préparé" };
    checks.push("contenu identique");
  }

  if (search.expectAttachment || search.attachmentName) {
    if (!message.hasAttachments) return { confirmed: false, detail: "aucune pièce jointe dans le message envoyé" };
    checks.push("pièce jointe présente");
    if (search.attachmentName) {
      // Mail.Read suffit à lire les métadonnées des pièces jointes.
      const attachments = await listAttachments(client, message.id);
      const wanted = normalizeText(search.attachmentName);
      const found = attachments.some((a) => normalizeText(a.name) === wanted || normalizeText(a.name).includes(wanted) || wanted.includes(normalizeText(a.name)));
      if (!found) return { confirmed: false, detail: `pièce jointe « ${search.attachmentName} » absente du message envoyé` };
      checks.push("document signé joint");
    }
  }

  return { confirmed: true, detail: checks.length ? checks.join(", ") : "aucun critère supplémentaire disponible" };
}

/**
 * Cherche l'envoi réel. `sent` seulement sur une correspondance forte : la
 * conversation ne suffit pas, chaque critère disponible (destinataire, objet,
 * contenu préparé, pièce jointe signée) doit également correspondre. Une
 * correspondance partielle donne `unknown` — jamais un faux `sent`, jamais un
 * second envoi automatique. Toute erreur de lecture Graph rend aussi le verdict
 * `unknown` : on ne conclut jamais « non envoyé » faute d'avoir pu vérifier.
 */
export async function reconcileSentMessage(client: GraphClient, search: SentSearch): Promise<ReconcileResult> {
  try {
    if (search.conversationId) {
      const message = await findLatestSentInConversation(client, search.conversationId, search.since);
      if (!message) return { verdict: "not_sent", message: null, detail: "aucun message envoyé dans cette conversation depuis la tentative" };
      const confirmation = await confirmMessage(client, message, search);
      if (confirmation.confirmed) return { verdict: "sent", message, detail: `message trouvé dans la conversation — ${confirmation.detail} (${message.sentDateTime ?? "date inconnue"})` };
      // Un message existe dans la conversation mais ne correspond pas à CET envoi.
      return { verdict: "unknown", message: null, detail: `message trouvé dans la conversation mais non concluant : ${confirmation.detail}` };
    }
    const wantedSubject = normalizeSubject(search.subject);
    const recipients = search.to ?? [];
    if (!wantedSubject || recipients.length === 0) {
      return { verdict: "unknown", message: null, detail: "critères insuffisants pour identifier l'envoi (objet ou destinataire manquant)" };
    }
    const candidates = await listSentSince(client, search.since, 25);
    const match = candidates.find((m) => normalizeSubject(m.subject) === wantedSubject && sameRecipient(m, recipients) && (!search.until || (m.sentDateTime ?? "") <= search.until));
    if (match) {
      const confirmation = await confirmMessage(client, match, search);
      if (!confirmation.confirmed) return { verdict: "unknown", message: null, detail: `envoi candidat non concluant : ${confirmation.detail}` };
      return { verdict: "sent", message: match, detail: `objet et destinataire identiques — ${confirmation.detail} (${match.sentDateTime ?? "date inconnue"})` };
    }
    const weak = candidates.some((m) => normalizeSubject(m.subject) === wantedSubject);
    if (weak) return { verdict: "unknown", message: null, detail: "objet identique mais destinataire différent : correspondance trop faible" };
    return { verdict: "not_sent", message: null, detail: "aucun envoi correspondant dans les éléments envoyés" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("reconciliation failed", { message });
    return { verdict: "unknown", message: null, detail: `vérification impossible : ${message}` };
  }
}
