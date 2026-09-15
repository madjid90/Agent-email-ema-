import type { Rule, EmailCategory } from "@/lib/config";
import type { EmailRow } from "@/database/types";

/**
 * Moteur de règles déterministe (config/rules.json). Les destinataires de
 * transfert viennent d'ici, jamais du modèle. Évaluation : priorité croissante,
 * première règle `forward` gagnante, `require_approval` cumulatif.
 */
export interface RuleFacts {
  category: EmailCategory | null;
  supplier: string | null; // nom d'organisation / société émettrice détectée
  senderEmail: string | null;
  subject: string;
  companyId: string | null;
  amount: number | null;
}

export interface RuleOutcome {
  matched: Rule[];
  forwardTo: string | null;
  forwardRule: Rule | null;
  requiresApproval: boolean;
  ignore: boolean;
  notify: string | null;
}

function includes(haystack: string | null | undefined, needle: string): boolean {
  return Boolean(haystack) && (haystack as string).toLowerCase().includes(needle.toLowerCase());
}

export function ruleMatches(rule: Rule, facts: RuleFacts): boolean {
  const w = rule.when;
  if (w.category && facts.category !== w.category) return false;
  if (w.supplierContains && !includes(facts.supplier, w.supplierContains) && !includes(facts.senderEmail, w.supplierContains) && !includes(facts.subject, w.supplierContains)) return false;
  if (w.senderEmail && (facts.senderEmail ?? "").toLowerCase() !== w.senderEmail.toLowerCase()) return false;
  if (w.senderDomain && !(facts.senderEmail ?? "").toLowerCase().endsWith(`@${w.senderDomain.toLowerCase()}`)) return false;
  if (w.subjectContains && !includes(facts.subject, w.subjectContains)) return false;
  if (w.companyId && facts.companyId !== w.companyId) return false;
  if (w.minAmount !== undefined && (facts.amount === null || facts.amount < w.minAmount)) return false;
  return true;
}

export function evaluateRules(rules: Rule[], facts: RuleFacts): RuleOutcome {
  const sorted = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  const outcome: RuleOutcome = { matched: [], forwardTo: null, forwardRule: null, requiresApproval: false, ignore: false, notify: null };
  for (const rule of sorted) {
    if (!ruleMatches(rule, facts)) continue;
    outcome.matched.push(rule);
    switch (rule.then.action) {
      case "forward":
        if (!outcome.forwardTo) {
          outcome.forwardTo = rule.then.to;
          outcome.forwardRule = rule;
          if (rule.then.requiresApproval) outcome.requiresApproval = true;
        }
        break;
      case "require_approval":
        outcome.requiresApproval = true;
        break;
      case "ignore":
        outcome.ignore = true;
        break;
      case "notify":
        outcome.notify = rule.then.message ?? rule.name;
        break;
      case "reply_template":
        if (rule.then.requiresApproval) outcome.requiresApproval = true;
        break;
    }
  }
  return outcome;
}

/**
 * Pré-sélection AVANT analyse (catégorie inconnue) : règles dont les conditions
 * connues (expéditeur, objet, domaine) sont compatibles avec l'email.
 * Les règles à condition de catégorie seule restent candidates.
 */
export function candidateRules(rules: Rule[], email: EmailRow): Rule[] {
  const facts: RuleFacts = { category: null, supplier: null, senderEmail: email.sender_email, subject: email.subject, companyId: null, amount: null };
  return rules
    .filter((r) => r.enabled)
    .filter((r) => {
      const w = r.when;
      if (w.senderEmail && (facts.senderEmail ?? "").toLowerCase() !== w.senderEmail.toLowerCase()) return false;
      if (w.senderDomain && !(facts.senderEmail ?? "").toLowerCase().endsWith(`@${w.senderDomain.toLowerCase()}`)) return false;
      if (w.subjectContains && !includes(facts.subject, w.subjectContains)) return false;
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}

export function describeRule(r: Rule): string {
  const conds: string[] = [];
  if (r.when.category) conds.push(`catégorie = ${r.when.category}`);
  if (r.when.supplierContains) conds.push(`fournisseur contient « ${r.when.supplierContains} »`);
  if (r.when.senderDomain) conds.push(`domaine expéditeur = ${r.when.senderDomain}`);
  if (r.when.senderEmail) conds.push(`expéditeur = ${r.when.senderEmail}`);
  if (r.when.subjectContains) conds.push(`objet contient « ${r.when.subjectContains} »`);
  if (r.when.companyId) conds.push(`société = ${r.when.companyId}`);
  if (r.when.minAmount !== undefined) conds.push(`montant ≥ ${r.when.minAmount}`);
  let effect: string;
  switch (r.then.action) {
    case "forward":
      effect = `transférer à ${r.then.to}${r.then.requiresApproval ? " (après validation)" : ""}`;
      break;
    case "reply_template":
      effect = `répondre avec le modèle « ${r.then.template} »`;
      break;
    case "require_approval":
      effect = "validation humaine obligatoire";
      break;
    case "notify":
      effect = "notifier l'utilisateur";
      break;
    case "ignore":
      effect = "ignorer";
      break;
  }
  return `si ${conds.length ? conds.join(" et ") : "toujours"} → ${effect}`;
}
