"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SyncButton({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/integrations/microsoft/sync", { method: "POST" });
    const json = (await res.json()) as { ok: boolean; data?: { inserted: number; attachments: number; errors: string[] }; error?: { message: string } };
    setBusy(false);
    if (!json.ok) setMsg(json.error?.message ?? "Erreur");
    else setMsg(`${json.data?.inserted ?? 0} nouvel(s) email(s)${json.data?.errors?.length ? ` — ${json.data.errors[0]}` : ""}`);
    router.refresh();
  }

  if (!connected) return <a className="btn small" href="/setup?step=outlook">Connecter Outlook</a>;
  return (
    <span className="row">
      {msg ? <span className="muted" style={{ fontSize: "0.85rem" }}>{msg}</span> : null}
      <button className="btn small primary" disabled={busy} onClick={() => void sync()}>{busy ? "Synchronisation…" : "Synchroniser"}</button>
    </span>
  );
}
