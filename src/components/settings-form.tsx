"use client";

import { useState, type FormEvent } from "react";
import type { Settings } from "@/lib/config";

export function SettingsForm({ initial, onSaved, compact }: { initial: Settings; onSaved?: () => void; compact?: boolean }) {
  const [s, setS] = useState<Settings>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/setup", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: s, completedStep: compact ? "company" : undefined }) });
    const json = (await res.json()) as { ok: boolean; error?: { message: string; details?: string[] } };
    setSaving(false);
    if (!json.ok) {
      setMsg({ tone: "danger", text: `${json.error?.message ?? "Erreur"}${json.error?.details ? ` : ${json.error.details.join(", ")}` : ""}` });
      return;
    }
    setMsg({ tone: "ok", text: "Paramètres enregistrés." });
    onSaved?.();
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Entreprise</h3>
      <div className="form-grid">
        <div className="field"><label>Nom de l&apos;entreprise</label><input value={s.company.name} onChange={(e) => setS({ ...s, company: { ...s.company, name: e.target.value } })} required /></div>
        <div className="field"><label>Nom de l&apos;utilisateur</label><input value={s.company.userName} onChange={(e) => setS({ ...s, company: { ...s.company, userName: e.target.value } })} required /></div>
        <div className="field"><label>Email</label><input type="email" value={s.company.email} onChange={(e) => setS({ ...s, company: { ...s.company, email: e.target.value } })} required /></div>
        <div className="field"><label>Langue</label><select value={s.company.language} onChange={(e) => setS({ ...s, company: { ...s.company, language: e.target.value as Settings["company"]["language"] } })}><option value="fr">Français</option><option value="en">English</option></select></div>
        <div className="field"><label>Fuseau horaire</label><input value={s.company.timezone} onChange={(e) => setS({ ...s, company: { ...s.company, timezone: e.target.value } })} placeholder="Europe/Paris" /></div>
      </div>
      {!compact ? (
        <>
          <h3 style={{ marginTop: "1rem" }}>Agent</h3>
          <div className="form-grid">
            <div className="field"><label>Signature des emails</label><textarea value={s.agent.signatureText} onChange={(e) => setS({ ...s, agent: { ...s.agent, signatureText: e.target.value } })} /></div>
            <div>
              <div className="field"><label>Délai de relance par défaut (jours)</label><input type="number" min={1} max={60} value={s.agent.defaultFollowupDelayDays} onChange={(e) => setS({ ...s, agent: { ...s.agent, defaultFollowupDelayDays: Number(e.target.value) } })} /></div>
              <div className="field"><label className="row"><input type="checkbox" checked={s.agent.autoReplyEnabled} onChange={(e) => setS({ ...s, agent: { ...s.agent, autoReplyEnabled: e.target.checked } })} style={{ width: "auto" }} /> Envoyer les réponses simples sans validation (déconseillé — sans effet en phase 3 : toute réponse est validée)</label></div>
            </div>
          </div>
          <h3 style={{ marginTop: "1rem" }}>Validations</h3>
          <div className="form-grid">
            <div className="field"><label>Canal</label><select value={s.approvals.channel} onChange={(e) => setS({ ...s, approvals: { ...s.approvals, channel: e.target.value as Settings["approvals"]["channel"] } })}><option value="whatsapp">WhatsApp</option><option value="ui">Interface uniquement</option></select></div>
            <div className="field"><label>Expiration d&apos;une demande (heures)</label><input type="number" min={1} max={720} value={s.approvals.expireAfterHours} onChange={(e) => setS({ ...s, approvals: { ...s.approvals, expireAfterHours: Number(e.target.value) } })} /></div>
          </div>
          <h3 style={{ marginTop: "1rem" }}>Analyse Claude</h3>
          <div className="form-grid">
            <div className="field"><label>Confiance « fiable » (≥)</label><input type="number" step="0.05" min={0} max={1} value={s.analysis.reliableThreshold} onChange={(e) => setS({ ...s, analysis: { ...s.analysis, reliableThreshold: Number(e.target.value) } })} /></div>
            <div className="field"><label>Confiance minimale sans validation humaine (≥)</label><input type="number" step="0.05" min={0} max={1} value={s.analysis.reviewThreshold} onChange={(e) => setS({ ...s, analysis: { ...s.analysis, reviewThreshold: Number(e.target.value) } })} /></div>
            <div className="field"><label>Effort du modèle</label><select value={s.analysis.effort} onChange={(e) => setS({ ...s, analysis: { ...s.analysis, effort: e.target.value as Settings["analysis"]["effort"] } })}><option value="low">Faible (rapide, économique)</option><option value="medium">Moyen</option><option value="high">Élevé</option></select></div>
            <div className="field"><label>Messages de thread envoyés au modèle (max)</label><input type="number" min={1} max={20} value={s.analysis.maxThreadMessages} onChange={(e) => setS({ ...s, analysis: { ...s.analysis, maxThreadMessages: Number(e.target.value) } })} /></div>
          </div>
          <h3 style={{ marginTop: "1rem" }}>Boîte mail</h3>
          <div className="form-grid">
            <div className="field"><label>Intervalle de scan (secondes)</label><input type="number" min={15} value={s.mailbox.pollIntervalSeconds} onChange={(e) => setS({ ...s, mailbox: { ...s.mailbox, pollIntervalSeconds: Number(e.target.value) } })} /></div>
            <div className="field"><label>Emails max par scan</label><input type="number" min={1} max={200} value={s.mailbox.maxEmailsPerScan} onChange={(e) => setS({ ...s, mailbox: { ...s.mailbox, maxEmailsPerScan: Number(e.target.value) } })} /></div>
          </div>
        </>
      ) : null}
      {msg ? <div className={`alert ${msg.tone}`}>{msg.text}</div> : null}
      <button className="btn primary" type="submit" disabled={saving}>Enregistrer</button>
    </form>
  );
}
