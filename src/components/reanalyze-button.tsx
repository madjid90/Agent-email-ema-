"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ReanalyzeButton({ emailId, label = "Réanalyser", small, endpoint }: { emailId: string; label?: string; small?: boolean; endpoint?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch(endpoint ?? `/api/emails/${emailId}/analyze`, { method: "POST" });
    const json = (await res.json()) as { ok: boolean; error?: { message: string } };
    setBusy(false);
    if (!json.ok) setError(json.error?.message ?? "Erreur");
    router.refresh();
  }

  return (
    <span className="row">
      <button className={`btn${small ? " small" : ""}`} disabled={busy} onClick={() => void run()}>{busy ? "Analyse en cours…" : label}</button>
      {error ? <span className="badge danger">{error}</span> : null}
    </span>
  );
}
