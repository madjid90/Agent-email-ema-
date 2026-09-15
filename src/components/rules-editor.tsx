"use client";

import { useState, type FormEvent } from "react";
import type { Contact, Rule, RulesFile } from "@/lib/config";

const CATEGORIES: { id: string; label: string }[] = [
  { id: "", label: "(toute catégorie)" },
  { id: "invoice", label: "Facture" },
  { id: "quote", label: "Devis" },
  { id: "payment", label: "Paiement" },
  { id: "deposit", label: "Acompte" },
  { id: "reminder", label: "Relance reçue" },
  { id: "administrative", label: "Administratif" },
  { id: "technical", label: "Technique" },
  { id: "information", label: "Information" },
  { id: "urgent", label: "Urgence" },
  { id: "document_to_sign", label: "Document à signer" },
  { id: "to_forward", label: "À transférer" },
  { id: "needs_reply", label: "À répondre" },
  { id: "other", label: "Autre" },
];

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || `regle-${Date.now()}`;
}

function describe(r: Rule): string {
  const conds: string[] = [];
  if (r.when.category) conds.push(`type = ${CATEGORIES.find((c) => c.id === r.when.category)?.label ?? r.when.category}`);
  if (r.when.supplierContains) conds.push(`fournisseur contient « ${r.when.supplierContains} »`);
  if (r.when.subjectContains) conds.push(`objet contient « ${r.when.subjectContains} »`);
  if (r.when.senderDomain) conds.push(`domaine = ${r.when.senderDomain}`);
  if (r.when.senderEmail) conds.push(`expéditeur = ${r.when.senderEmail}`);
  if (r.when.companyId) conds.push(`société = ${r.when.companyId}`);
  if (r.when.minAmount !== undefined) conds.push(`montant ≥ ${r.when.minAmount}`);
  const cond = conds.length ? conds.join(" et ") : "toujours";
  let effect = "";
  switch (r.then.action) {
    case "forward": effect = `transférer à ${r.then.to}${r.then.requiresApproval ? " (après validation)" : ""}`; break;
    case "reply_template": effect = `répondre avec le modèle « ${r.then.template} »`; break;
    case "require_approval": effect = "validation obligatoire"; break;
    case "notify": effect = "notifier"; break;
    case "ignore": effect = "ignorer"; break;
  }
  return `si ${cond} alors ${effect}`;
}

export function RulesEditor({ initial, contacts }: { initial: RulesFile; contacts: Contact[] }) {
  const [rules, setRules] = useState<Rule[]>(initial.rules);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [form, setForm] = useState({ name: "", category: "", supplierContains: "", subjectContains: "", senderDomain: "", action: "forward", to: contacts[0]?.email ?? "", requiresApproval: true, priority: 50 });

  async function persist(next: Rule[]) {
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: initial.version, rules: next }) });
    const json = (await res.json()) as { ok: boolean; data?: RulesFile; error?: { message: string; details?: string[] } };
    setSaving(false);
    if (!json.ok) {
      setMsg({ tone: "danger", text: `${json.error?.message ?? "Erreur"}${json.error?.details ? ` : ${json.error.details.join(", ")}` : ""}` });
      return;
    }
    setRules(json.data?.rules ?? next);
    setMsg({ tone: "ok", text: "Règles enregistrées." });
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const when: Rule["when"] = {};
    if (form.category) when.category = form.category as Rule["when"]["category"];
    if (form.supplierContains) when.supplierContains = form.supplierContains;
    if (form.subjectContains) when.subjectContains = form.subjectContains;
    if (form.senderDomain) when.senderDomain = form.senderDomain;
    let then: Rule["then"];
    if (form.action === "forward") then = { action: "forward", to: form.to, requiresApproval: form.requiresApproval };
    else if (form.action === "require_approval") then = { action: "require_approval" };
    else if (form.action === "notify") then = { action: "notify" };
    else then = { action: "ignore" };
    const id = slug(form.name || `${form.category}-${form.to}`);
    if (rules.some((r) => r.id === id)) {
      setMsg({ tone: "danger", text: `Une règle avec l'identifiant « ${id} » existe déjà.` });
      return;
    }
    const rule: Rule = { id, name: form.name || describe({ id, name: "", enabled: true, priority: form.priority, when, then }), enabled: true, priority: form.priority, when, then };
    void persist([...rules, rule]);
    setForm({ ...form, name: "", supplierContains: "", subjectContains: "", senderDomain: "" });
  }

  return (
    <>
      <div className="card">
        <h3>Règles actuelles</h3>
        {rules.length === 0 ? <p className="muted">Aucune règle.</p> : (
          <table>
            <thead><tr><th>Priorité</th><th>Nom</th><th>Règle</th><th>Actif</th><th></th></tr></thead>
            <tbody>
              {[...rules].sort((a, b) => a.priority - b.priority).map((r) => (
                <tr key={r.id}>
                  <td>{r.priority}</td>
                  <td>{r.name}<br /><span className="muted" style={{ fontSize: "0.8rem" }}>{r.id}</span></td>
                  <td>{describe(r)}</td>
                  <td><input type="checkbox" checked={r.enabled} disabled={saving} onChange={(e) => void persist(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} style={{ width: "auto" }} /></td>
                  <td><button className="btn small danger" disabled={saving} onClick={() => void persist(rules.filter((x) => x.id !== r.id))}>Supprimer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {msg ? <div className={`alert ${msg.tone}`} style={{ marginTop: "0.75rem" }}>{msg.text}</div> : null}
      </div>

      <form className="card" onSubmit={add}>
        <h3>Nouvelle règle</h3>
        <div className="form-grid">
          <div className="field"><label>Nom</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Facture Brink's vers Magali" /></div>
          <div className="field"><label>Priorité (plus petit = évalué en premier)</label><input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></div>
          <div className="field"><label>Si type =</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
          <div className="field"><label>et fournisseur contient</label><input value={form.supplierContains} onChange={(e) => setForm({ ...form, supplierContains: e.target.value })} placeholder="brink" /></div>
          <div className="field"><label>et objet contient</label><input value={form.subjectContains} onChange={(e) => setForm({ ...form, subjectContains: e.target.value })} placeholder="paie" /></div>
          <div className="field"><label>et domaine expéditeur</label><input value={form.senderDomain} onChange={(e) => setForm({ ...form, senderDomain: e.target.value })} placeholder="fournisseur.fr" /></div>
          <div className="field"><label>alors</label>
            <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              <option value="forward">transférer à</option>
              <option value="require_approval">exiger une validation</option>
              <option value="notify">notifier</option>
              <option value="ignore">ignorer</option>
            </select>
          </div>
          {form.action === "forward" ? (
            <div className="field"><label>Destinataire</label>
              <input list="contacts" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="prenom@entreprise.fr" required />
              <datalist id="contacts">{contacts.map((c) => <option key={c.id} value={c.email}>{c.name} — {c.role}</option>)}</datalist>
            </div>
          ) : null}
        </div>
        {form.action === "forward" ? (
          <div className="field"><label className="row"><input type="checkbox" checked={form.requiresApproval} onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })} style={{ width: "auto" }} /> Demander une validation WhatsApp avant transfert</label></div>
        ) : null}
        <button className="btn primary" type="submit" disabled={saving}>Ajouter la règle</button>
      </form>
    </>
  );
}
