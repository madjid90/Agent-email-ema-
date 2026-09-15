"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Action = "cancel" | "postpone" | "prepare_now" | "done";

/** Actions sur une relance : voir le thread, préparer maintenant, reporter, annuler. */
export function FollowupButtons({ followupId, kind, status, emailId, actionId }: { followupId: string; kind: string; status: string; emailId: string | null; actionId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function call(action: Action, days = 3) {
    setBusy(action);
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/followups/${followupId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, days }) });
    const json = (await res.json()) as { ok: boolean; data?: { outcome?: string; message?: string }; error?: { message: string } };
    setBusy(null);
    if (!json.ok) setError(json.error?.message ?? "Erreur");
    else if (json.data?.message) setInfo(json.data.message);
    router.refresh();
  }

  const isReminder = kind === "INTERNAL_REMINDER";
  const canPrepare = !isReminder && (status === "SCHEDULED" || status === "CHECK_FAILED" || status === "REVIEW_REQUIRED" || status === "MAX_ATTEMPTS_REACHED" || status === "FAILED");

  return (
    <div className="stack">
      <div className="row">
        {emailId ? <Link className="btn small" href={`/emails/${emailId}`}>Voir le thread</Link> : null}
        {actionId ? <Link className="btn small" href="/a-valider">Voir la relance</Link> : null}
        {canPrepare ? (
          <button className="btn small primary" disabled={busy !== null} onClick={() => void call("prepare_now")}>
            {busy === "prepare_now" ? "Vérification…" : "Préparer maintenant"}
          </button>
        ) : null}
        {isReminder ? (
          <button className="btn small primary" disabled={busy !== null} onClick={() => void call("done")}>Terminé</button>
        ) : null}
        <button className="btn small" disabled={busy !== null} onClick={() => void call("postpone")}>Reporter (+3 j)</button>
        <button className="btn small" disabled={busy !== null} onClick={() => void call("cancel")}>Annuler</button>
      </div>
      {info ? <span className="muted">{info}</span> : null}
      {error ? <span className="badge danger">{error}</span> : null}
    </div>
  );
}
