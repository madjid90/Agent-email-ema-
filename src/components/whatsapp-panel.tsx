"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface WhatsappPanelStatus {
  configured: boolean;
  tokenConfigured: boolean;
  phoneNumberIdConfigured: boolean;
  verifyTokenConfigured: boolean;
  appSecretConfigured: boolean;
  approverPhone: string | null;
  approverConfigured: boolean;
  lastTestAt: string | null;
  lastTestResult: string | null;
  webhookPath: string;
  assistantEnabled: boolean;
}

export function WhatsappPanel({ status, appUrl }: { status: WhatsappPanelStatus; appUrl: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function test() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/integrations/whatsapp/test", { method: "POST" });
    const json = (await res.json()) as { ok: boolean; data?: { test: { ok: boolean; message: string } }; error?: { message: string } };
    setBusy(false);
    if (!json.ok) setMsg({ tone: "danger", text: json.error?.message ?? "Erreur" });
    else setMsg({ tone: json.data?.test.ok ? "ok" : "danger", text: json.data?.test.message ?? "" });
    router.refresh();
  }

  const missing = [
    !status.tokenConfigured ? "WHATSAPP_ACCESS_TOKEN" : null,
    !status.phoneNumberIdConfigured ? "WHATSAPP_PHONE_NUMBER_ID" : null,
    !status.verifyTokenConfigured ? "WHATSAPP_VERIFY_TOKEN" : null,
    !status.approverConfigured ? "WHATSAPP_APPROVER_PHONE" : null,
  ].filter((v): v is string => v !== null);

  return (
    <div className="card">
      <h3>WhatsApp Business Cloud API</h3>
      {status.configured ? (
        <div className="alert ok">
          <strong>✅ Connecté</strong>
          <div className="form-grid" style={{ marginTop: "0.5rem" }}>
            <p><span className="muted">Numéro de validation :</span> {status.approverPhone}</p>
            <p><span className="muted">Webhook :</span> <code>{appUrl}{status.webhookPath}</code></p>
            <p><span className="muted">Signature des webhooks :</span> {status.appSecretConfigured ? "vérifiée (WHATSAPP_APP_SECRET)" : "non configurée — obligatoire en production"}</p>
            <p><span className="muted">Dernier test :</span> {status.lastTestAt ? `${status.lastTestAt} (${status.lastTestResult})` : "—"}</p>
          </div>
        </div>
      ) : (
        <div className="alert warn">Variables manquantes dans <code>.env</code> : {missing.map((m) => <code key={m} style={{ marginRight: "0.4rem" }}>{m}</code>)}. Seul le numéro autorisé peut valider les actions.</div>
      )}
      <div className={`alert ${status.assistantEnabled && status.configured ? "ok" : "warn"}`} style={{ marginTop: "0.75rem" }}>
        <strong>{status.assistantEnabled ? "✅ Assistant WhatsApp activé" : "⏸ Assistant WhatsApp désactivé"}</strong>
        {status.assistantEnabled ? (
          <div className="form-grid" style={{ marginTop: "0.5rem" }}>
            <p><span className="muted">Numéro autorisé :</span> {status.approverPhone ?? "—"} — seul ce numéro peut écrire à EMA.</p>
            <p className="muted">Vous pouvez désormais utiliser EMA directement depuis WhatsApp : poser une question, faire rédiger un email, préparer un transfert ou une signature. Chaque action reste soumise à validation.</p>
            <p className="muted">{"Exemples : « Qu'est-ce que j'ai d'important aujourd'hui ? » · « Réponds à Kevin que mardi me convient. » · « Quels devis dois-je signer ? »"}</p>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            <code>WHATSAPP_ASSISTANT_ENABLED=false</code> : les messages texte sont ignorés. Les validations par boutons continuent de fonctionner.
          </p>
        )}
      </div>
      {msg ? <div className={`alert ${msg.tone}`}>{msg.text}</div> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !status.configured} onClick={() => void test()}>{busy ? "Envoi…" : "Envoyer un message test"}</button>
      </div>
    </div>
  );
}
