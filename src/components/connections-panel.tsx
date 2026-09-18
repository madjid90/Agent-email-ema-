"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export interface OutlookConnection {
  configured: boolean;
  connected: boolean;
  status: "active" | "revoked" | "disconnected";
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export interface WhatsappConnection {
  configured: boolean;
  businessNumberDisplay: string | null;
  openLink: string | null;
  status: "not_registered" | "pending" | "active" | "disabled";
  phoneDisplay: string | null;
  activationText: string;
}

type Msg = { tone: "ok" | "danger" | "info"; text: string } | null;

/**
 * Paramètres → Connexions : la boîte Outlook et le WhatsApp DU compte connecté.
 * Aucun token n'atteint le navigateur ; seuls des états et des adresses masquées.
 */
export function ConnectionsPanel({ outlook, whatsapp, notice }: { outlook: OutlookConnection; whatsapp: WhatsappConnection; notice?: Msg }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(notice ?? null);
  const [phone, setPhone] = useState("");

  async function api(path: string, init?: RequestInit): Promise<{ ok: boolean; message?: string }> {
    const res = await fetch(path, init);
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string }; data?: { test?: { ok: boolean; message: string } } };
    if (!res.ok || !json.ok) return { ok: false, message: json.error?.message ?? "Erreur" };
    return { ok: true, message: json.data?.test?.message };
  }

  async function disconnectOutlook() {
    if (!window.confirm("Déconnecter Outlook ? EMA ne pourra plus lire ni envoyer vos emails jusqu'à une nouvelle connexion.")) return;
    setBusy("outlook");
    const r = await api("/api/integrations/microsoft/disconnect", { method: "POST" });
    setBusy(null);
    setMsg(r.ok ? { tone: "info", text: "Outlook déconnecté." } : { tone: "danger", text: r.message ?? "Erreur" });
    router.refresh();
  }

  async function testOutlook() {
    setBusy("test");
    const r = await api("/api/integrations/microsoft/status?test=1");
    setBusy(null);
    setMsg({ tone: r.ok ? "ok" : "danger", text: r.message ?? "" });
  }

  async function registerPhone(e: FormEvent) {
    e.preventDefault();
    setBusy("phone");
    const r = await api("/api/me/phone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: "Numéro enregistré. Envoyez maintenant un message à EMA depuis ce numéro pour terminer l'activation." } : { tone: "danger", text: r.message ?? "Numéro invalide" });
    router.refresh();
  }

  async function deactivateWhatsapp() {
    if (!window.confirm("Désactiver WhatsApp ? EMA ne répondra plus à ce numéro.")) return;
    setBusy("phone");
    const r = await api("/api/me/phone", { method: "DELETE" });
    setBusy(null);
    setMsg(r.ok ? { tone: "info", text: "WhatsApp désactivé." } : { tone: "danger", text: r.message ?? "Erreur" });
    router.refresh();
  }

  return (
    <div className="stack">
      {msg ? <div className={`alert ${msg.tone === "ok" ? "ok" : msg.tone === "danger" ? "danger" : "info"}`}>{msg.text}</div> : null}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Microsoft Outlook</h2>
        {!outlook.configured ? (
          <div className="alert warn">L&apos;application Microsoft (MICROSOFT_CLIENT_ID / SECRET / REDIRECT_URI) n&apos;est pas configurée sur cette instance.</div>
        ) : outlook.status === "active" ? (
          <>
            <p>
              <span className="badge ok">✅ Connecté</span> <strong>{outlook.accountEmail ?? "adresse inconnue"}</strong>
            </p>
            <p className="muted">
              Dernière synchronisation : {outlook.lastSyncAt ? new Date(outlook.lastSyncAt).toLocaleString("fr-FR") : "jamais"}
              {outlook.lastSyncError ? ` — dernière erreur : ${outlook.lastSyncError}` : ""}
            </p>
            <div className="row">
              <button className="btn small" onClick={testOutlook} disabled={busy !== null}>Tester la connexion</button>
              <button className="btn small danger" onClick={disconnectOutlook} disabled={busy !== null}>Déconnecter</button>
            </div>
          </>
        ) : (
          <>
            {outlook.status === "revoked" ? <div className="alert danger">Votre connexion Microsoft a expiré ou a été révoquée. Reconnectez Outlook.</div> : null}
            <p>Permettez à EMA de consulter et d&apos;envoyer vos emails, en votre nom uniquement (permissions déléguées, aucun mot de passe saisi dans EMA).</p>
            <a className="btn primary" href="/api/integrations/microsoft/connect">
              {outlook.status === "revoked" ? "Reconnecter Outlook" : "Connecter Outlook"}
            </a>
          </>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>WhatsApp</h2>
        {!whatsapp.configured ? <div className="alert warn">Le numéro WhatsApp Business d&apos;EMA n&apos;est pas configuré sur cette instance (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_NUMBER).</div> : null}
        {whatsapp.status === "active" ? (
          <>
            <p>
              <span className="badge ok">✅ Activé</span> <strong>{whatsapp.phoneDisplay}</strong>
            </p>
            <p className="muted">Écrivez à EMA sur WhatsApp{whatsapp.businessNumberDisplay ? ` (${whatsapp.businessNumberDisplay})` : ""} depuis ce numéro : vos emails, vos validations, vos relances.</p>
            <div className="row">
              {whatsapp.openLink ? <a className="btn small" href={whatsapp.openLink} target="_blank" rel="noreferrer">Ouvrir WhatsApp</a> : null}
              <button className="btn small danger" onClick={deactivateWhatsapp} disabled={busy !== null}>Désactiver</button>
            </div>
          </>
        ) : whatsapp.status === "pending" ? (
          <>
            <p>
              <span className="badge warn">En attente d&apos;activation</span> <strong>{whatsapp.phoneDisplay}</strong>
            </p>
            <p>Envoyez maintenant un message à EMA depuis ce numéro (par exemple « {whatsapp.activationText} ») : votre numéro sera reconnu et WhatsApp activé.</p>
            <div className="row">
              {whatsapp.openLink ? (
                <a className="btn primary" href={whatsapp.openLink} target="_blank" rel="noreferrer">Ouvrir WhatsApp</a>
              ) : (
                <span className="muted">Numéro EMA non renseigné (WHATSAPP_BUSINESS_NUMBER) : écrivez au numéro WhatsApp Business d&apos;EMA communiqué par votre contact.</span>
              )}
              <button className="btn small" onClick={deactivateWhatsapp} disabled={busy !== null}>Changer de numéro</button>
            </div>
          </>
        ) : (
          <form onSubmit={registerPhone} className="stack">
            {whatsapp.status === "disabled" ? <p className="muted">WhatsApp est désactivé pour ce compte. Enregistrez votre numéro pour le réactiver.</p> : <p>Utilisez WhatsApp pour parler directement à EMA. Votre WhatsApp personnel n&apos;est jamais connecté à EMA : vous écrivez simplement au numéro d&apos;EMA.</p>}
            <div className="field">
              <label htmlFor="phone">Votre numéro</label>
              <input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+33 6 12 34 56 78" autoComplete="tel" required />
            </div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy !== null}>Continuer</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
