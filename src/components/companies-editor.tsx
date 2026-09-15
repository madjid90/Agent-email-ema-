"use client";

import { useState, type FormEvent } from "react";
import type { CompaniesFile, Company } from "@/lib/config";

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || `societe-${Date.now()}`;
}

const EMPTY: Company = { id: "", name: "", legalForm: "", siret: "", address: "", signatory: { name: "", title: "" }, signaturePath: null, stampPath: null, aliases: [] };

export function CompaniesEditor({ initial }: { initial: CompaniesFile }) {
  const [companies, setCompanies] = useState<Company[]>(initial.companies);
  const [editing, setEditing] = useState<Company | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function persist(next: Company[]) {
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/companies", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: initial.version, companies: next }) });
    const json = (await res.json()) as { ok: boolean; data?: CompaniesFile; error?: { message: string; details?: string[] } };
    setSaving(false);
    if (!json.ok) {
      setMsg({ tone: "danger", text: `${json.error?.message ?? "Erreur"}${json.error?.details ? ` : ${json.error.details.join(", ")}` : ""}` });
      return false;
    }
    setCompanies(json.data?.companies ?? next);
    setMsg({ tone: "ok", text: "Sociétés enregistrées." });
    return true;
  }

  async function upload(companyId: string, kind: "signature" | "stamp", file: File) {
    setSaving(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("file", file);
    const res = await fetch(`/api/companies/${companyId}/assets`, { method: "POST", body: fd });
    const json = (await res.json()) as { ok: boolean; data?: { path: string }; error?: { message: string } };
    setSaving(false);
    if (!json.ok) {
      setMsg({ tone: "danger", text: json.error?.message ?? "Erreur d'upload" });
      return;
    }
    setCompanies(companies.map((c) => (c.id === companyId ? { ...c, [kind === "signature" ? "signaturePath" : "stampPath"]: json.data?.path ?? null } : c)));
    setMsg({ tone: "ok", text: `${kind === "signature" ? "Signature" : "Tampon"} enregistré.` });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const id = editing.id || slug(editing.name);
    const c: Company = { ...editing, id };
    const exists = companies.some((x) => x.id === id);
    const next = exists ? companies.map((x) => (x.id === id ? c : x)) : [...companies, c];
    if (await persist(next)) setEditing(null);
  }

  return (
    <>
      <div className="card">
        <div className="row between"><h3 style={{ margin: 0 }}>Sociétés</h3><button className="btn primary small" onClick={() => setEditing({ ...EMPTY })}>Ajouter une société</button></div>
        {companies.length === 0 ? <p className="muted" style={{ marginTop: "0.75rem" }}>Aucune société.</p> : (
          <table style={{ marginTop: "0.75rem" }}>
            <thead><tr><th>Nom</th><th>Signataire</th><th>Signature</th><th>Tampon</th><th></th></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td>{c.name} {c.legalForm ? <span className="muted">({c.legalForm})</span> : null}<br /><span className="muted" style={{ fontSize: "0.8rem" }}>{c.id}{c.aliases.length ? ` · alias : ${c.aliases.join(", ")}` : ""}</span></td>
                  <td>{c.signatory.name}<br /><span className="muted">{c.signatory.title}</span></td>
                  <td>
                    <span className={`badge ${c.signaturePath ? "ok" : "warn"}`}>{c.signaturePath ? "OK" : "Manquante"}</span>
                    <input type="file" accept="image/png" disabled={saving} style={{ marginTop: "0.35rem" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(c.id, "signature", f); }} />
                  </td>
                  <td>
                    <span className={`badge ${c.stampPath ? "ok" : "warn"}`}>{c.stampPath ? "OK" : "Manquant"}</span>
                    <input type="file" accept="image/png" disabled={saving} style={{ marginTop: "0.35rem" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(c.id, "stamp", f); }} />
                  </td>
                  <td className="row">
                    <button className="btn small" disabled={saving} onClick={() => setEditing({ ...c })}>Modifier</button>
                    <button className="btn small danger" disabled={saving} onClick={() => void persist(companies.filter((x) => x.id !== c.id))}>Supprimer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {msg ? <div className={`alert ${msg.tone}`} style={{ marginTop: "0.75rem" }}>{msg.text}</div> : null}
      </div>

      {editing ? (
        <form className="card" onSubmit={submit}>
          <h3>{editing.id ? "Modifier la société" : "Nouvelle société"}</h3>
          <div className="form-grid">
            <div className="field"><label>Nom</label><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required /></div>
            <div className="field"><label>Forme juridique</label><input value={editing.legalForm} onChange={(e) => setEditing({ ...editing, legalForm: e.target.value })} placeholder="SAS" /></div>
            <div className="field"><label>SIRET</label><input value={editing.siret} onChange={(e) => setEditing({ ...editing, siret: e.target.value })} /></div>
            <div className="field"><label>Adresse</label><input value={editing.address} onChange={(e) => setEditing({ ...editing, address: e.target.value })} /></div>
            <div className="field"><label>Signataire</label><input value={editing.signatory.name} onChange={(e) => setEditing({ ...editing, signatory: { ...editing.signatory, name: e.target.value } })} required /></div>
            <div className="field"><label>Fonction</label><input value={editing.signatory.title} onChange={(e) => setEditing({ ...editing, signatory: { ...editing.signatory, title: e.target.value } })} placeholder="Président" /></div>
            <div className="field"><label>Alias (séparés par des virgules)</label><input value={editing.aliases.join(", ")} onChange={(e) => setEditing({ ...editing, aliases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></div>
          </div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={saving}>Enregistrer</button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>Annuler</button>
          </div>
        </form>
      ) : null}
    </>
  );
}
