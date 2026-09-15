"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface OutlookPanelStatus {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  scopes: string[];
  lastSyncAt: string | null;
  lastEmailAt: string | null;
  lastSyncError: string | null;
}

function fmt(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-FR", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function OutlookPanel({ status, timezone, notice }: { status: OutlookPanelStatus; timezone: string; notice?: { tone: "ok" | "danger"; text: string } | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "info"; text: string } | null>(notice ?? null);

  async function call(kind: "test" | "sync" | "disconnect") {
    if (kind === "disconnect" && !window.confirm("Déconnecter Outlook ? Les tokens seront supprimés ; la synchronisation s'arrêtera.")) return;
    setBusy(kind);
    setMsg(null);
    const res = kind === "test" ? await fetch("/api/integrations/microsoft/status?test=1") : await fetch(`/api/integrations/microsoft/${kind}`, { method: "POST" });
    const json = (await res.json()) as { ok: boolean; data?: { test?: { ok: boolean; message: string }; inserted?: number; attachments?: number; errors?: string[] }; error?: { message: string } };
    setBusy(null);
    if (!json.ok) {
      setMsg({ tone: "danger", text: json.error?.message ?? "Erreur" });
      return;
    }
    if (kind === "test") setMsg({ tone: json.data?.test?.ok ? "ok" : "danger", text: json.data?.test?.message ?? "" });
    if (kind === "sync") setMsg({ tone: json.data?.errors?.length ? "danger" : "ok", text: `${json.data?.inserted ?? 0} nouvel(s) email(s), ${json.data?.attachments ?? 0} pièce(s) jointe(s)${json.data?.errors?.length ? ` — ${json.data.errors[0]}` : ""}` });
    if (kind === "disconnect") setMsg({ tone: "info", text: "Outlook déconnecté." });
    router.refresh();
  }

  return (
    <div className="card">
      <h3>Outlook (Microsoft Graph)</h3>
      {!status.configured ? (
        <div className="alert warn">Renseignez <code>MICROSOFT_CLIENT_ID</code>, <code>MICROSOFT_CLIENT_SECRET</code>, <code>MICROSOFT_TENANT_ID</code> et <code>MICROSOFT_REDIRECT_URI</code> dans <code>.env</code>, puis redémarrez EMA.</div>
      ) : null}
      {status.connected ? (
        <div className="alert ok">
          <strong>✅ Outlook connecté</strong>
          <div className="form-grid" style={{ marginTop: "0.5rem" }}>
            <p><span className="muted">Adresse :</span> {status.accountEmail ?? "—"}</p>
            <p><span className="muted">Permissions :</span> {status.scopes.length ? status.scopes.join(", ") : "—"}</p>
            <p><span className="muted">Dernière synchronisation :</span> {fmt(status.lastSyncAt, timezone)}</p>
            <p><span className="muted">Dernier email détecté :</span> {fmt(status.lastEmailAt, timezone)}</p>
          </div>
          {status.lastSyncError ? <p style={{ marginTop: "0.5rem", color: "var(--danger)" }}>Dernière erreur : {status.lastSyncError}</p> : null}
        </div>
      ) : (
        <p className="muted">EMA ne demande jamais votre mot de passe : la connexion passe par OAuth Microsoft avec les seules permissions Mail.Read, Mail.Send, User.Read et offline_access.</p>
      )}
      {msg ? <div className={`alert ${msg.tone}`}>{msg.text}</div> : null}
      <div className="row">
        {!status.connected ? (
          <a className="btn primary" href="/api/integrations/microsoft/connect" aria-disabled={!status.configured} onClick={(e) => { if (!status.configured) e.preventDefault(); }}>Connecter Outlook</a>
        ) : (
          <>
            <button className="btn" disabled={busy !== null} onClick={() => void call("test")}>{busy === "test" ? "…" : "Tester"}</button>
            <button className="btn primary" disabled={busy !== null} onClick={() => void call("sync")}>{busy === "sync" ? "Synchronisation…" : "Synchroniser maintenant"}</button>
            <button className="btn danger" disabled={busy !== null} onClick={() => void call("disconnect")}>Déconnecter</button>
          </>
        )}
      </div>
    </div>
  );
}
