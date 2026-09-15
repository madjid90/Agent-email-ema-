"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ActionButtons({ actionId, documentId }: { actionId: string; documentId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function call(kind: "approve" | "reject") {
    setBusy(kind);
    setMessage(null);
    const res = await fetch(`/api/actions/${actionId}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const json = (await res.json()) as { ok: boolean; data?: { status: string; error: string | null }; error?: { message: string } };
    setBusy(null);
    if (!json.ok) {
      setMessage({ tone: "danger", text: json.error?.message ?? "Erreur" });
      return;
    }
    if (kind === "approve" && json.data?.status === "FAILED") {
      setMessage({ tone: "danger", text: `Validée, mais l'exécution a échoué : ${json.data.error ?? "erreur inconnue"}` });
    } else {
      setMessage({ tone: "ok", text: kind === "approve" ? "Action validée et exécutée." : "Action refusée." });
    }
    router.refresh();
  }

  return (
    <div className="stack" style={{ marginTop: "1rem" }}>
      <div className="row">
        {documentId ? <a className="btn" href={`/api/documents/${documentId}/file`} target="_blank" rel="noreferrer">Voir PDF</a> : null}
        <button className="btn primary" disabled={busy !== null} onClick={() => call("approve")}>{busy === "approve" ? "…" : "Valider"}</button>
        <button className="btn danger" disabled={busy !== null} onClick={() => call("reject")}>{busy === "reject" ? "…" : "Refuser"}</button>
      </div>
      {message ? <div className={`alert ${message.tone}`}>{message.text}</div> : null}
    </div>
  );
}
