import { describe, it, expect } from "vitest";
import { evaluateRules, candidateRules, describeRule } from "@/agent/rules";
import { rulesFileSchema, type Rule } from "@/lib/config";
import { openIsolatedDb } from "@/database/connection";
import * as emails from "@/database/repositories/emails";

const rules: Rule[] = [
  { id: "brinks", name: "Brink's", enabled: true, priority: 10, when: { category: "INVOICE", supplierContains: "brink" }, then: { action: "forward", to: "magali@exemple.fr", requiresApproval: true } },
  { id: "default", name: "Défaut", enabled: true, priority: 100, when: { category: "INVOICE" }, then: { action: "forward", to: "nabila@exemple.fr", requiresApproval: false } },
  { id: "paie", name: "Paie", enabled: true, priority: 20, when: { subjectContains: "paie" }, then: { action: "forward", to: "julie@exemple.fr", requiresApproval: true } },
  { id: "pay", name: "Paiement", enabled: true, priority: 1, when: { category: "PAYMENT_REQUEST" }, then: { action: "require_approval" } },
  { id: "off", name: "Désactivée", enabled: false, priority: 0, when: {}, then: { action: "ignore" } },
  { id: "big", name: "Gros montant", enabled: true, priority: 5, when: { minAmount: 10000 }, then: { action: "require_approval" } },
];

describe("Moteur de règles", () => {
  it("première règle forward par priorité, approbation héritée", () => {
    const r = evaluateRules(rules, { category: "INVOICE", supplier: "Brink's France", senderEmail: "x@brinks.fr", subject: "Facture", companyId: null, amount: 200 });
    expect(r.forwardTo).toBe("magali@exemple.fr");
    expect(r.requiresApproval).toBe(true);
    expect(r.matched.map((m) => m.id)).toEqual(["brinks", "default"]);
  });

  it("règle par défaut sans approbation, montant élevé force l'approbation", () => {
    const r = evaluateRules(rules, { category: "INVOICE", supplier: "Autre", senderEmail: "a@b.fr", subject: "Facture", companyId: null, amount: 200 });
    expect(r.forwardTo).toBe("nabila@exemple.fr");
    expect(r.requiresApproval).toBe(false);
    const big = evaluateRules(rules, { category: "INVOICE", supplier: "Autre", senderEmail: "a@b.fr", subject: "Facture", companyId: null, amount: 20000 });
    expect(big.requiresApproval).toBe(true);
  });

  it("objet, désactivation, absence de correspondance", () => {
    expect(evaluateRules(rules, { category: "ADMIN_REQUEST", supplier: null, senderEmail: null, subject: "Bulletins de PAIE", companyId: null, amount: null }).forwardTo).toBe("julie@exemple.fr");
    const none = evaluateRules(rules, { category: "INFORMATION", supplier: null, senderEmail: null, subject: "Newsletter", companyId: null, amount: null });
    expect(none.forwardTo).toBeNull();
    expect(none.ignore).toBe(false);
  });

  it("présélection avant analyse : conditions connues seulement", () => {
    const db = openIsolatedDb();
    const e = emails.insertEmail({ graphId: "g", subject: "Facture", senderEmail: "x@brinks.fr", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    expect(candidateRules(rules, e).map((r) => r.id)).toEqual(["pay", "big", "brinks", "default"]);
  });

  it("accepte les anciennes catégories minuscules dans config/rules.json", () => {
    const parsed = rulesFileSchema.parse({ version: 1, rules: [{ id: "x", name: "x", when: { category: "invoice" }, then: { action: "forward", to: "a@b.fr" } }] });
    expect(parsed.rules[0]?.when.category).toBe("INVOICE");
    expect(describeRule(parsed.rules[0]!)).toContain("catégorie = INVOICE");
  });
});
