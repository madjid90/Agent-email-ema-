import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import type { EmailRow } from "@/database/types";
import { parseJson } from "@/database/types";
import { getContacts, getRules, getSettings, type Contact, type Rule, type Settings } from "@/lib/config";
import { EmaError } from "@/lib/errors";

/**
 * Résolution et contrôle des destinataires sortants (phase 8A).
 *
 * Le modèle ne fournit jamais une adresse : il désigne un `contact_id` ou un
 * email existant. Le backend résout l'adresse depuis `config/contacts.json`,
 * `config/rules.json` ou les messages réellement présents en base, puis
 * `validateOutboundRecipients` revérifie l'adresse juste avant l'envoi.
 */
export interface RecipientSources {
  db?: Db;
  contacts?: Contact[];
  rules?: Rule[];
  settings?: Settings;
}

function sources(deps: RecipientSources): { db: Db; contacts: Contact[]; rules: Rule[]; settings: Settings } {
  return { db: deps.db ?? getDb(), contacts: deps.contacts ?? getContacts(), rules: deps.rules ?? getRules(), settings: deps.settings ?? getSettings() };
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Identifiant logique accepté : `contact_id`, `mailbox:<email>` (expéditeur connu) ou un email déjà présent en base. */
export interface ResolvedRecipient {
  email: string;
  label: string;
  source: "contact" | "rule" | "thread" | "self";
}

/** Résout un `contact_id` en adresse. Lève une erreur exploitable si inconnu. */
export function resolveContactId(contactId: string, deps: RecipientSources = {}): ResolvedRecipient {
  const { contacts, db, settings } = sources(deps);
  const contact = contacts.find((c) => c.id === contactId);
  if (contact) return { email: contact.email, label: `${contact.name} <${contact.email}>`, source: "contact" };

  // `mailbox:<email>` : expéditeur réellement reçu dans la boîte (search_contacts).
  const mailbox = contactId.startsWith("mailbox:") ? contactId.slice("mailbox:".length) : null;
  if (mailbox && knownCorrespondent(mailbox, db)) {
    return { email: mailbox, label: mailbox, source: "thread" };
  }
  if (settings.company.email && normalizeEmail(contactId) === normalizeEmail(settings.company.email)) {
    return { email: settings.company.email, label: settings.company.email, source: "self" };
  }
  throw new EmaError(
    "VALIDATION",
    `Contact « ${contactId} » inconnu : ajoutez-le dans les contacts (config/contacts.json) ou précisez lequel utiliser. Aucune adresse n'est inventée.`,
  );
}

/** Une adresse qui a déjà écrit ou reçu un message dans la mailbox. */
export function knownCorrespondent(email: string, db: Db): boolean {
  const target = normalizeEmail(email);
  const bySender = db.prepare("SELECT 1 FROM emails WHERE lower(sender_email) = ? LIMIT 1").get(target);
  if (bySender) return true;
  const rows = db.prepare("SELECT to_recipients, cc_recipients FROM emails WHERE to_recipients LIKE ? OR cc_recipients LIKE ? LIMIT 20").all(`%${target}%`, `%${target}%`) as { to_recipients: string; cc_recipients: string }[];
  return rows.some((r) => [...parseJson<string[]>(r.to_recipients, []), ...parseJson<string[]>(r.cc_recipients, [])].some((a) => normalizeEmail(a) === target));
}

/** Adresses autorisées par la configuration (contacts + règles + boîte du client). */
export function configuredRecipients(deps: RecipientSources = {}): Set<string> {
  const { contacts, rules, settings } = sources(deps);
  const allowed = new Set<string>();
  for (const c of contacts) allowed.add(normalizeEmail(c.email));
  for (const r of rules) if (r.then.action === "forward" && r.then.to) allowed.add(normalizeEmail(r.then.to));
  if (settings.company.email) allowed.add(normalizeEmail(settings.company.email));
  return allowed;
}

export interface OutboundCheck {
  /** Email du thread concerné : ses participants sont des destinataires légitimes. */
  threadEmail?: EmailRow | null;
}

/**
 * Dernier rempart avant un envoi : chaque destinataire doit provenir d'une
 * source de confiance (contact configuré, règle, participant réel du thread,
 * boîte du client). Une adresse simplement présente dans le payload ne suffit
 * pas — c'est le contrôle qui rattrape un payload modifié ou un tool contourné.
 */
export function validateOutboundRecipients(addresses: string[], deps: RecipientSources & OutboundCheck = {}): void {
  const { db } = sources(deps);
  if (addresses.length === 0) throw new EmaError("VALIDATION", "Aucun destinataire");
  const allowed = configuredRecipients(deps);
  const threadAddresses = new Set<string>();
  const email = deps.threadEmail;
  if (email) {
    if (email.sender_email) threadAddresses.add(normalizeEmail(email.sender_email));
    for (const a of [...parseJson<string[]>(email.to_recipients, []), ...parseJson<string[]>(email.cc_recipients, [])]) threadAddresses.add(normalizeEmail(a));
  }
  for (const address of addresses) {
    const target = normalizeEmail(address);
    if (allowed.has(target) || threadAddresses.has(target)) continue;
    if (knownCorrespondent(target, db)) continue;
    throw new EmaError(
      "FORBIDDEN",
      `Destinataire non autorisé : ${address}. Un envoi n'est possible que vers un contact configuré, un destinataire de règle ou un correspondant réel de la boîte.`,
    );
  }
}
