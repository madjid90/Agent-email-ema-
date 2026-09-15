"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface ApprovalCardProps {
  actionId: string;
  actionStatus: string;
  approvalStatus: string | null; // PENDING | APPROVED | REJECTED | EXPIRED | MODIFIED | null
  notified: boolean;
  notifyError: string | null;
  draft: string | null;
  editable: boolean;
  actionError: string | null;
  documentId: string | null;
  whatsappConfigured: boolean;
}

type Feedback = { tone: "ok" | "danger" | "info"; text: string } | null;

export function ApprovalCard(p: ApprovalCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.draft ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Feedback>(null);

  async function call(kind: "approve" | "reject" | "notify" | "retry" | "payload", body?: unknown) {
    setBusy(kind);
    setMsg(null);
    const res = await fetch(`/api/actions/${p.actionId}/${kind}`, {
      method: kind === "payload" ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json()) as { ok: boolean; data?: { status?: string; error?: string | null; sent?: boolean; reason?: string }; error?: { message: string } };
    setBusy(null);
    if (!json.ok) {
      setMsg({ tone: "danger", text: json.error?.message ?? "Erreur" });
      return;
    }
    if (kind === "approve" || kind === "retry") {
      if (json.data?.status === "COMPLETED") setMsg({ tone: "ok", text: "Validé et envoyé." });
      else setMsg({ tone: "danger", text: `Validé mais l'envoi a échoué : ${json.data?.error ?? "erreur inconnue"}. Vous pouvez réessayer.` });
    } else if (kind === "reject") setMsg({ tone: "info", text: "Action refusée. Aucun email envoyé." });
    else if (kind === "notify") setMsg({ tone: json.data?.sent ? "ok" : "danger", text: json.data?.sent ? "Demande envoyée sur WhatsApp." : `Demande non envoyée : ${json.data?.reason ?? "?"}` });
    else if (kind === "payload") {
      setEditing(false);
      setMsg({ tone: "ok", text: "Brouillon modifié. Il sera envoyé tel quel après validation." });
    }
    router.refresh();
  }

  const label = (() => {
    if (p.actionStatus === "COMPLETED") return { tone: "ok", text: "Envoyé" };
    if (p.actionStatus === "FAILED") return { tone: "danger", text: "Échec" };
    if (p.actionStatus === "REJECTED") return { tone: "danger", text: "Refusé" };
    if (p.actionStatus === "APPROVED" || p.actionStatus === "EXECUTING") return { tone: "primary", text: "Validé" };
    if (p.approvalStatus === "EXPIRED") return { tone: "", text: "Expiré" };
    return { tone: "warn", text: "En attente" };
  })();
  const pending = p.actionStatus === "WAITING_APPROVAL" || p.actionStatus === "PROPOSED";

  return (
    <div className="stack" style={{ marginTop: "0.75rem" }}>
      <div className="row">
        <span className={`badge ${label.tone}`}>{label.text}</span>
        {pending ? (
          p.notified ? <span className="badge ok">Demande WhatsApp envoyée</span> : p.notifyError ? <span className="badge danger" title={p.notifyError}>WhatsApp : {p.notifyError}</span> : p.whatsappConfigured ? <span className="badge">WhatsApp : en attente d&apos;envoi</span> : <span className="badge">WhatsApp non configuré</span>
        ) : null}
      </div>
      {p.draft !== null ? (
        editing ? (
          <>
            <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 180 }} />
            <div className="row">
              <button className="btn primary small" disabled={busy !== null || !text.trim()} onClick={() => void call("payload", { body: text })}>Enregistrer la modification</button>
              <button className="btn small" disabled={busy !== null} onClick={() => { setEditing(false); setText(p.draft ?? ""); }}>Annuler</button>
            </div>
          </>
        ) : (
          <pre className="mono">{p.draft}</pre>
        )
      ) : null}
      {p.actionError ? <div className="alert danger">Erreur : {p.actionError}</div> : null}
      {msg ? <div className={`alert ${msg.tone}`}>{msg.text}</div> : null}
      <div className="row">
        {p.documentId ? <a className="btn" href={`/api/documents/${p.documentId}/file`} target="_blank" rel="noreferrer">Voir PDF</a> : null}
        {pending && p.editable && !editing ? <button className="btn" disabled={busy !== null} onClick={() => setEditing(true)}>Modifier</button> : null}
        {pending && !editing ? <button className="btn primary" disabled={busy !== null} onClick={() => { if (window.confirm("Valider et envoyer réellement cet email ?")) void call("approve"); }}>{busy === "approve" ? "Envoi…" : "Valider et envoyer"}</button> : null}
        {pending && !editing ? <button className="btn danger" disabled={busy !== null} onClick={() => void call("reject")}>Refuser</button> : null}
        {pending && !editing && (p.approvalStatus === "EXPIRED" || (!p.notified && p.whatsappConfigured)) ? <button className="btn" disabled={busy !== null} onClick={() => void call("notify")}>{busy === "notify" ? "…" : "Renvoyer la demande"}</button> : null}
        {p.actionStatus === "FAILED" ? <button className="btn primary" disabled={busy !== null} onClick={() => void call("retry")}>{busy === "retry" ? "…" : "Réessayer l'envoi"}</button> : null}
      </div>
    </div>
  );
}
