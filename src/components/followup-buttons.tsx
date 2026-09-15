"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function FollowupButtons({ followupId }: { followupId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(action: "cancel" | "postpone" | "execute_now") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/followups/${followupId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, days: 3 }) });
    const json = (await res.json()) as { ok: boolean; error?: { message: string } };
    setBusy(false);
    if (!json.ok) setError(json.error?.message ?? "Erreur");
    router.refresh();
  }

  return (
    <div className="stack">
      <div className="row">
        <button className="btn small" disabled={busy} onClick={() => call("cancel")}>Annuler</button>
        <button className="btn small" disabled={busy} onClick={() => call("postpone")}>Reporter (+3 j)</button>
        <button className="btn small primary" disabled={busy} onClick={() => call("execute_now")}>Exécuter maintenant</button>
      </div>
      {error ? <span className="badge danger">{error}</span> : null}
    </div>
  );
}
