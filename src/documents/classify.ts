import type { DocumentType } from "./types";

/**
 * Pré-classification heuristique (nom de fichier + texte). Sert d'indice
 * fourni au modèle et de secours ; la classification finale est validée par
 * le schéma de sortie de Claude puis par les garde-fous.
 */
const PATTERNS: { type: DocumentType; re: RegExp; weight: number }[] = [
  { type: "CREDIT_NOTE", re: /\b(avoir|credit\s*note|note\s+de\s+cr[ée]dit)\b/i, weight: 3 },
  { type: "INVOICE", re: /\b(facture|invoice|fact\.?\s*n[°o])\b/i, weight: 2 },
  { type: "QUOTE", re: /\b(devis|quotation|quote|proposition\s+commerciale|bon\s+pour\s+accord)\b/i, weight: 2 },
  { type: "PAYMENT_PROOF", re: /\b(justificatif|preuve)\s+de\s+(paiement|virement)|avis\s+de\s+virement|payment\s+(confirmation|receipt)|remittance/i, weight: 3 },
  { type: "BANK_DETAILS", re: /\b(rib|relev[ée]\s+d'identit[ée]\s+bancaire|iban|bic|coordonn[ée]es\s+bancaires)\b/i, weight: 1 },
  { type: "PURCHASE_ORDER", re: /\b(bon\s+de\s+commande|purchase\s+order|\bPO\s*n[°o])\b/i, weight: 2 },
  { type: "CONTRACT", re: /\b(contrat|contract|conditions\s+g[ée]n[ée]rales|convention)\b/i, weight: 1 },
];

export const IBAN_REGEX = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
export const BANK_CHANGE_REGEX = /(nouveau|nouvel|nouvelle|nouvelles|changement\s+d[e']|modification\s+d[e']|mise\s+à\s+jour\s+d[e']|updated?|new)\s+(rib|iban|coordonn[ée]es\s+bancaires|bank\s+(details|account))|(rib|iban|coordonn[ée]es\s+bancaires)\s+(a|ont)\s+chang[ée]|chang[ée]\s+de\s+(rib|iban|coordonn[ée]es\s+bancaires|banque)/i;

export interface ClassificationHint {
  type: DocumentType;
  score: number;
  ibanPresent: boolean;
  ibanLast4: string | null;
  bankChangeSuspected: boolean;
}

export function classifyDocumentHeuristic(filename: string, text: string | null): ClassificationHint {
  const haystack = `${filename}\n${(text ?? "").slice(0, 6000)}`;
  const scores = new Map<DocumentType, number>();
  for (const p of PATTERNS) {
    const matches = haystack.match(new RegExp(p.re.source, `${p.re.flags.replace("g", "")}g`))?.length ?? 0;
    if (matches > 0) scores.set(p.type, (scores.get(p.type) ?? 0) + p.weight * Math.min(matches, 3));
  }
  // Un avoir mentionne souvent "facture" : l'avoir l'emporte s'il est présent.
  if (scores.has("CREDIT_NOTE") && scores.has("INVOICE")) scores.set("INVOICE", (scores.get("INVOICE") ?? 0) - 2);
  // Un IBAN seul ne fait pas un RIB : la plupart des factures en contiennent un.
  if (scores.has("BANK_DETAILS") && (scores.has("INVOICE") || scores.has("QUOTE") || scores.has("CREDIT_NOTE"))) scores.delete("BANK_DETAILS");
  let best: DocumentType = text && text.trim().length > 0 ? "OTHER" : "UNKNOWN";
  let bestScore = 0;
  for (const [type, score] of scores) {
    if (score > bestScore) {
      best = type;
      bestScore = score;
    }
  }
  const ibans = (text ?? "").replace(/\s+/g, " ").match(IBAN_REGEX) ?? [];
  const iban = ibans.map((i) => i.replace(/\s/g, "")).find((i) => i.length >= 15) ?? null;
  return { type: best, score: bestScore, ibanPresent: iban !== null, ibanLast4: iban ? iban.slice(-4) : null, bankChangeSuspected: BANK_CHANGE_REGEX.test(text ?? "") };
}
