"use client";

import { useState } from "react";

type Tone = "ok" | "danger" | "info";
type Notice = { tone: Tone; text: string } | null;

export interface PocStateView {
  enabled: boolean;
  configured: boolean;
  configError: string | null;
  status: "disconnected" | "connecting" | "connected" | "error" | "reconnect_required";
  accountEmail: string | null;
  statusReason: string | null;
  requestedScopes: string[];
  writeScopesDetected: string[];
  lastError: string | null;
  lastCheckedAt: string | null;
  adminApprovalRequired: boolean;
}

const STATUS_LABEL: Record<PocStateView["status"], { label: string; badge: string }> = {
  disconnected: { label: "Déconnecté", badge: "warn" },
  connecting: { label: "Connexion en cours", badge: "warn" },
  connected: { label: "Connecté", badge: "ok" },
  error: { label: "Erreur", badge: "danger" },
  reconnect_required: { label: "Reconnexion requise", badge: "danger" },
};

type ReadOp = "list_recent" | "search" | "get_message" | "list_attachments" | "get_attachment" | "list_events";

/** Écran de test : aucun secret technique n'est affiché (états, adresse, scopes demandés, résultats de lecture). */
export function ComposioPocPanel({ initial, notice }: { initial: PocStateView; notice: Notice }) {
  const [state, setState] = useState<PocStateView>(initial);
  const [msg, setMsg] = useState<Notice>(notice);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [messageId, setMessageId] = useState("");
  const [attachmentId, setAttachmentId] = useState("");
  const [output, setOutput] = useState<{ title: string; body: string } | null>(null);
  const [tools, setTools] = useState<{ allowed: { slug: string; parameters: string[] }[]; blocked: { slug: string }[] } | null>(null);

  async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
    const res = await fetch(path, init);
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: { message?: string } };
    if (!res.ok || !json.ok || json.data === undefined) return { ok: false, message: json.error?.message ?? `Erreur ${res.status}` };
    return { ok: true, data: json.data };
  }

  async function connect() {
    setBusy("connect");
    const r = await api<{ redirectUrl: string }>("/api/poc/composio/connect", { method: "POST" });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "danger", text: r.message });
    window.location.href = r.data.redirectUrl;
  }

  async function refresh() {
    setBusy("refresh");
    const r = await api<PocStateView>("/api/poc/composio/status?refresh=1");
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "danger", text: r.message });
    setState(r.data);
    setMsg({ tone: r.data.status === "connected" ? "ok" : "info", text: `Statut Composio : ${STATUS_LABEL[r.data.status].label}${r.data.statusReason ? ` — ${r.data.statusReason}` : ""}` });
  }

  async function disconnect() {
    if (!window.confirm("Déconnecter Outlook via Composio ? Les identifiants seront révoqués côté Composio.")) return;
    setBusy("disconnect");
    const r = await api<PocStateView>("/api/poc/composio/disconnect", { method: "POST" });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "danger", text: r.message });
    setState(r.data);
    setOutput(null);
    setMsg({ tone: "info", text: "Déconnecté." });
  }

  async function loadTools() {
    setBusy("tools");
    const r = await api<{ allowed: { slug: string; parameters: string[] }[]; blocked: { slug: string }[] }>("/api/poc/composio/tools");
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "danger", text: r.message });
    setTools(r.data);
  }

  async function read(operation: ReadOp, title: string) {
    setBusy(operation);
    const body: Record<string, unknown> = { operation };
    if (operation === "search") body.query = query;
    if (operation === "get_message" || operation === "list_attachments" || operation === "get_attachment") body.message_id = messageId;
    if (operation === "get_attachment") body.attachment_id = attachmentId;
    const r = await api<{ ok: boolean; tool: string; data: unknown; error: string | null }>("/api/poc/composio/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "danger", text: r.message });
    setOutput({ title: `${title} — tool ${r.data.tool}${r.data.ok ? "" : " — ÉCHEC"}`, body: r.data.ok ? JSON.stringify(r.data.data, null, 2) : (r.data.error ?? "Erreur") });
    if (!r.data.ok && /reconnect|expired|revoked|401/i.test(r.data.error ?? "")) void refresh();
  }

  const s = STATUS_LABEL[state.status];
  const connected = state.status === "connected";

  return (
    <div className="stack">
      {msg ? <div className={`alert ${msg.tone}`}>{msg.text}</div> : null}
      {!state.configured ? <div className="alert warn">POC non configuré : {state.configError}</div> : null}
      {state.adminApprovalRequired ? <div className="alert danger"><strong>Microsoft administrator approval required.</strong> Le tenant Microsoft exige l&apos;approbation d&apos;un administrateur pour cette application : EMA ne contourne pas cette étape.</div> : null}
      {state.writeScopesDetected.length ? <div className="alert danger">Scopes d&apos;écriture demandés par l&apos;auth config Composio : {state.writeScopesDetected.join(", ")}. Le POC les refuse à l&apos;exécution, mais l&apos;auth config doit être limitée à la lecture (Mail.Read, Calendars.Read, User.Read, offline_access).</div> : null}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Outlook via Composio</h2>
        <p>
          <span className={`badge ${s.badge}`}>{s.label}</span> {state.accountEmail ? <strong>{state.accountEmail}</strong> : connected ? <span className="muted">adresse non déterminée (tool de profil indisponible)</span> : null}
        </p>
        {state.statusReason ? <p className="muted">Motif : {state.statusReason}</p> : null}
        {state.lastError ? <p className="muted">Dernière erreur : {state.lastError}</p> : null}
        {state.requestedScopes.length ? <p className="muted">Scopes demandés : {state.requestedScopes.join(", ")}</p> : null}
        <div className="row">
          {state.status === "disconnected" || state.status === "error" ? (
            <button className="btn primary" onClick={connect} disabled={busy !== null || !state.configured}>Connecter Outlook via Composio</button>
          ) : null}
          {state.status === "reconnect_required" ? <button className="btn primary" onClick={connect} disabled={busy !== null}>Reconnecter</button> : null}
          {state.status === "connecting" ? <button className="btn primary" onClick={connect} disabled={busy !== null}>Relancer la connexion</button> : null}
          {state.status !== "disconnected" ? <button className="btn small" onClick={refresh} disabled={busy !== null}>Tester la connexion</button> : null}
          {state.status !== "disconnected" ? <button className="btn small danger" onClick={disconnect} disabled={busy !== null}>Déconnecter</button> : null}
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Tests de lecture (aucune écriture possible)</h2>
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button className="btn small" onClick={() => read("list_recent", "5 derniers emails")} disabled={!connected || busy !== null}>5 derniers emails</button>
          <button className="btn small" onClick={() => read("list_events", "Calendrier (14 jours)")} disabled={!connected || busy !== null}>Calendrier</button>
          <button className="btn small" onClick={loadTools} disabled={busy !== null}>Tools disponibles (diagnostic)</button>
        </div>
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="q">Rechercher par texte</label>
          <div className="row">
            <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ex. devis Julien" />
            <button className="btn small" onClick={() => read("search", `Recherche « ${query} »`)} disabled={!connected || busy !== null || !query.trim()}>Rechercher</button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="mid">Identifiant de message (issu d&apos;un résultat ci-dessus)</label>
          <div className="row">
            <input id="mid" value={messageId} onChange={(e) => setMessageId(e.target.value)} placeholder="id du message" />
            <button className="btn small" onClick={() => read("get_message", "Détails du message")} disabled={!connected || busy !== null || !messageId.trim()}>Détails</button>
            <button className="btn small" onClick={() => read("list_attachments", "Pièces jointes")} disabled={!connected || busy !== null || !messageId.trim()}>Pièces jointes</button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="aid">Identifiant de pièce jointe</label>
          <div className="row">
            <input id="aid" value={attachmentId} onChange={(e) => setAttachmentId(e.target.value)} placeholder="id de la pièce jointe" />
            <button className="btn small" onClick={() => read("get_attachment", "Pièce jointe (métadonnées)")} disabled={!connected || busy !== null || !messageId.trim() || !attachmentId.trim()}>Récupérer</button>
          </div>
        </div>
        {output ? (
          <>
            <h3>{output.title}</h3>
            <pre style={{ maxHeight: 420, overflow: "auto", fontSize: "0.8rem" }}>{output.body}</pre>
          </>
        ) : null}
        {tools ? (
          <>
            <h3>Tools autorisés (lecture) — {tools.allowed.length}</h3>
            <ul>{tools.allowed.map((t) => <li key={t.slug}><code>{t.slug}</code> <span className="muted">({t.parameters.join(", ") || "sans paramètre"})</span></li>)}</ul>
            <h3>Tools refusés par la politique — {tools.blocked.length}</h3>
            <ul>{tools.blocked.map((t) => <li key={t.slug}><code>{t.slug}</code></li>)}</ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
