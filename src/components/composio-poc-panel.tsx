"use client";

import { useEffect, useState } from "react";

type Tone = "ok" | "danger" | "info";
type Notice = { tone: Tone; text: string } | null;

export interface PocStateView {
  enabled: boolean;
  configured: boolean;
  configError: string | null;
  callbackMode: "verified" | "local";
  callbackWarning: string | null;
  status: "disconnected" | "connecting" | "connected" | "error" | "reconnect_required";
  accountEmail: string | null;
  statusReason: string | null;
  requestedScopes: string[];
  writeScopesDetected: string[];
  lastError: string | null;
  lastCheckedAt: string | null;
  adminApprovalRequired: boolean;
}

export interface PreflightView {
  ready: boolean;
  checks: { key: string; label: string; level: "OK" | "WARN" | "FAIL"; detail: string }[];
  callbackMode: "verified" | "local" | null;
  baseUrl: string;
  expectedExecutableTools: number;
  capabilities: readonly string[];
  readOnlyScopes: readonly string[];
}

const STATUS_LABEL: Record<PocStateView["status"], { label: string; badge: string }> = {
  disconnected: { label: "Déconnecté", badge: "warn" },
  connecting: { label: "Connexion en cours", badge: "warn" },
  connected: { label: "Connecté", badge: "ok" },
  error: { label: "Erreur", badge: "danger" },
  reconnect_required: { label: "Reconnexion requise", badge: "danger" },
};

type ReadOp = "list_recent" | "search" | "get_message" | "list_attachments" | "get_attachment" | "list_events";

/** Étapes du smoke test guidé (ordre imposé par la procédure `docs/composio-poc.md`). */
export const SMOKE_STEPS = [
  "Preflight",
  "Connecter Outlook",
  "Vérifier l'identité du compte",
  "Lire les 5 derniers emails",
  "Rechercher un email",
  "Lire les détails d'un email",
  "Lister les pièces jointes",
  "Récupérer une pièce jointe",
  "Lire le calendrier",
  "Vérifier qu'aucun tool WRITE n'est exécutable",
  "Déconnexion",
  "Reconnexion",
] as const;

type StepResult = "untested" | "ok" | "fail";
type StepResults = Record<number, StepResult>;
const STEP_LABEL: Record<StepResult, { label: string; badge: string }> = { untested: { label: "PAS TESTÉ", badge: "warn" }, ok: { label: "OK", badge: "ok" }, fail: { label: "ÉCHEC", badge: "danger" } };

/**
 * Le tableau ne vit que dans le navigateur (sessionStorage, onglet courant) :
 * uniquement des états OK / ÉCHEC par numéro d'étape, jamais une donnée lue
 * (id, adresse, contenu). Il survit au seul aller-retour OAuth de l'onglet.
 */
const SMOKE_KEY = "ema.poc.composio.smoke";
function loadSteps(): StepResults {
  try {
    const raw = window.sessionStorage.getItem(SMOKE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: StepResults = {};
    for (const [k, v] of Object.entries(parsed)) if (v === "ok" || v === "fail") out[Number(k)] = v;
    return out;
  } catch {
    return {};
  }
}
function saveSteps(steps: StepResults): void {
  try {
    window.sessionStorage.setItem(SMOKE_KEY, JSON.stringify(steps));
  } catch {
    /* stockage indisponible : le tableau reste en mémoire */
  }
}

type ToolsView = { allowed: { slug: string; parameters: string[]; required: string[] }[]; readOnlyUnused: { slug: string }[]; blocked: { slug: string }[]; summary: { executable: number; readOnlyUnused: number; blocked: number; writeToolsExecutable: number; writeToolsExecutableSlugs: string[]; pocFailed: boolean } };

/** Écran de test : aucun secret technique n'est affiché (états, adresse, scopes demandés, résultats de lecture). */
export function ComposioPocPanel({ initial, preflight: initialPreflight, notice, returned }: { initial: PocStateView; preflight: PreflightView; notice: Notice; returned: boolean }) {
  const [state, setState] = useState<PocStateView>(initial);
  const [preflight, setPreflight] = useState<PreflightView>(initialPreflight);
  const [msg, setMsg] = useState<Notice>(notice);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [messageId, setMessageId] = useState("");
  const [attachmentId, setAttachmentId] = useState("");
  const [output, setOutput] = useState<{ title: string; body: string } | null>(null);
  const [tools, setTools] = useState<ToolsView | null>(null);
  const [steps, setSteps] = useState<StepResults>({});

  function mark(step: number, result: StepResult) {
    setSteps((prev) => {
      const next = { ...prev, [step]: result };
      saveSteps(next);
      return next;
    });
  }

  // Retour du parcours OAuth : l'étape 1 (ou 11 après une déconnexion) est jugée sur l'état relu, l'étape 2 sur l'adresse.
  useEffect(() => {
    const stored = loadSteps();
    if (returned) {
      const connected = initial.status === "connected";
      const reconnecting = stored[10] === "ok";
      stored[reconnecting ? 11 : 1] = connected ? "ok" : "fail";
      if (connected) stored[2] = initial.accountEmail ? "ok" : "fail";
      saveSteps(stored);
    }
    setSteps(stored);
  }, [returned, initial.status, initial.accountEmail]);

  async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
    const res = await fetch(path, init);
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: { message?: string } };
    if (!res.ok || !json.ok || json.data === undefined) return { ok: false, message: json.error?.message ?? `Erreur ${res.status}` };
    return { ok: true, data: json.data };
  }

  async function runPreflight() {
    setBusy("preflight");
    const r = await api<PreflightView>("/api/poc/composio/preflight");
    setBusy(null);
    if (!r.ok) {
      mark(0, "fail");
      return setMsg({ tone: "danger", text: r.message });
    }
    setPreflight(r.data);
    mark(0, r.data.ready ? "ok" : "fail");
    setMsg({ tone: r.data.ready ? "ok" : "danger", text: r.data.ready ? "Preflight OK : configuration prête pour le test réel." : "Preflight en échec : corriger les points en rouge avant toute connexion." });
  }

  async function connect() {
    setBusy("connect");
    const r = await api<{ redirectUrl: string }>("/api/poc/composio/connect", { method: "POST" });
    setBusy(null);
    if (!r.ok) {
      mark(steps[10] === "ok" ? 11 : 1, "fail");
      return setMsg({ tone: "danger", text: r.message });
    }
    window.location.href = r.data.redirectUrl;
  }

  async function refresh() {
    setBusy("refresh");
    const r = await api<PocStateView>("/api/poc/composio/status?refresh=1");
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "danger", text: r.message });
    setState(r.data);
    if (r.data.status === "connected") mark(2, r.data.accountEmail ? "ok" : "fail");
    setMsg({ tone: r.data.status === "connected" ? "ok" : "info", text: `Statut Composio : ${STATUS_LABEL[r.data.status].label}${r.data.statusReason ? ` — ${r.data.statusReason}` : ""}` });
  }

  async function disconnect() {
    if (!window.confirm("Déconnecter Outlook via Composio ? Les identifiants seront révoqués côté Composio.")) return;
    setBusy("disconnect");
    const r = await api<PocStateView>("/api/poc/composio/disconnect", { method: "POST" });
    setBusy(null);
    if (!r.ok) {
      mark(10, "fail");
      return setMsg({ tone: "danger", text: r.message });
    }
    setState(r.data);
    setOutput(null);
    mark(10, r.data.status === "disconnected" ? "ok" : "fail");
    setMsg({ tone: "info", text: "Déconnecté." });
  }

  async function loadTools() {
    setBusy("tools");
    const r = await api<ToolsView>("/api/poc/composio/tools");
    setBusy(null);
    if (!r.ok) {
      mark(9, "fail");
      return setMsg({ tone: "danger", text: r.message });
    }
    setTools(r.data);
    mark(9, r.data.summary.writeToolsExecutable === 0 ? "ok" : "fail");
  }

  const STEP_OF_OP: Record<ReadOp, number> = { list_recent: 3, search: 4, get_message: 5, list_attachments: 6, get_attachment: 7, list_events: 8 };

  async function read(operation: ReadOp, title: string) {
    setBusy(operation);
    const body: Record<string, unknown> = { operation };
    if (operation === "search") body.query = query;
    if (operation === "get_message" || operation === "list_attachments" || operation === "get_attachment") body.message_id = messageId;
    if (operation === "get_attachment") body.attachment_id = attachmentId;
    const r = await api<{ ok: boolean; tool: string; data: unknown; error: string | null }>("/api/poc/composio/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) {
      mark(STEP_OF_OP[operation], "fail");
      return setMsg({ tone: "danger", text: r.message });
    }
    mark(STEP_OF_OP[operation], r.data.ok ? "ok" : "fail");
    setOutput({ title: `${title} — tool ${r.data.tool}${r.data.ok ? "" : " — ÉCHEC"}`, body: r.data.ok ? JSON.stringify(r.data.data, null, 2) : (r.data.error ?? "Erreur") });
    if (!r.data.ok && /reconnect|expired|revoked|401/i.test(r.data.error ?? "")) void refresh();
  }

  function resetSteps() {
    setSteps({});
    saveSteps({});
  }

  const s = STATUS_LABEL[state.status];
  const connected = state.status === "connected";
  const failedSteps = Object.values(steps).filter((v) => v === "fail").length;
  const okSteps = Object.values(steps).filter((v) => v === "ok").length;
  const writeFailure = tools ? tools.summary.writeToolsExecutable !== 0 : false;

  return (
    <div className="stack">
      {msg ? <div className={`alert ${msg.tone}`}>{msg.text}</div> : null}
      {!state.configured ? <div className="alert warn">POC non configuré : {state.configError}</div> : null}
      {state.callbackWarning ? <div className="alert warn">⚠️ {state.callbackWarning}</div> : null}
      {state.callbackMode === "verified" ? <p className="muted">Retour OAuth protégé par Callback Identity Verification (verifier URL du projet Composio → <code>/api/poc/composio/callback</code>).</p> : null}
      {state.adminApprovalRequired ? <div className="alert danger"><strong>Microsoft administrator approval required.</strong> Le tenant Microsoft exige l&apos;approbation d&apos;un administrateur pour cette application : EMA ne contourne pas cette étape.</div> : null}
      {state.writeScopesDetected.length ? <div className="alert danger">Scopes d&apos;écriture demandés par l&apos;auth config Composio : {state.writeScopesDetected.join(", ")}. Le POC les refuse à l&apos;exécution, mais l&apos;auth config doit être limitée à la lecture (Mail.Read, Calendars.Read, User.Read, offline_access).</div> : null}
      {writeFailure ? <div className="alert danger"><strong>POC EN ÉCHEC :</strong> {tools?.summary.writeToolsExecutable} tool(s) d&apos;écriture exécutable(s) ({tools?.summary.writeToolsExecutableSlugs.join(", ")}). Ne pas poursuivre le test réel.</div> : null}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>0. Preflight (configuration, sans aucune valeur secrète)</h2>
        <p>
          <span className={`badge ${preflight.ready ? "ok" : "danger"}`}>{preflight.ready ? "PRÊT" : "NON PRÊT"}</span>{" "}
          <span className="muted">Mode de retour : {preflight.callbackMode ?? "indéterminé"} · URL Composio : {preflight.baseUrl} · tools exécutables attendus : {preflight.expectedExecutableTools} · capacités : {preflight.capabilities.join(", ")}</span>
        </p>
        <table className="table">
          <thead><tr><th>Contrôle</th><th>État</th><th>Détail</th></tr></thead>
          <tbody>
            {preflight.checks.map((c) => (
              <tr key={c.key}><td>{c.label}</td><td><span className={`badge ${c.level === "OK" ? "ok" : c.level === "WARN" ? "warn" : "danger"}`}>{c.level}</span></td><td className="muted">{c.detail}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="row"><button className="btn small" onClick={runPreflight} disabled={busy !== null}>Relancer le preflight</button></div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Smoke test guidé</h2>
        <p className="muted">Les états ci-dessous ne vivent que dans cet onglet (aucune donnée lue n&apos;est conservée). {okSteps} OK · {failedSteps} ÉCHEC · {SMOKE_STEPS.length - okSteps - failedSteps} non testé(s).</p>
        <table className="table">
          <thead><tr><th>#</th><th>Étape</th><th>Résultat</th></tr></thead>
          <tbody>
            {SMOKE_STEPS.map((label, i) => {
              const r = STEP_LABEL[steps[i] ?? "untested"];
              return <tr key={label}><td>{i}</td><td>{label}</td><td><span className={`badge ${r.badge}`}>{r.label}</span></td></tr>;
            })}
          </tbody>
        </table>
        <div className="row"><button className="btn small" onClick={resetSteps} disabled={busy !== null}>Réinitialiser le tableau</button></div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>1–2. Outlook via Composio</h2>
        <p>
          <span className={`badge ${s.badge}`}>{s.label}</span> {state.accountEmail ? <strong>{state.accountEmail}</strong> : connected ? <span className="muted">adresse non déterminée (tool de profil indisponible)</span> : null}
        </p>
        {state.statusReason ? <p className="muted">Motif : {state.statusReason}</p> : null}
        {state.lastError ? <p className="muted">Dernière erreur : {state.lastError}</p> : null}
        {state.requestedScopes.length ? <p className="muted">Scopes demandés : {state.requestedScopes.join(", ")}</p> : null}
        <div className="row">
          {state.status === "disconnected" || state.status === "error" ? (
            <button className="btn primary" onClick={connect} disabled={busy !== null || !state.configured || !preflight.ready}>{steps[10] === "ok" ? "Reconnecter Outlook via Composio" : "Connecter Outlook via Composio"}</button>
          ) : null}
          {state.status === "reconnect_required" ? <button className="btn primary" onClick={connect} disabled={busy !== null}>Reconnecter</button> : null}
          {state.status === "connecting" ? <button className="btn primary" onClick={connect} disabled={busy !== null}>Relancer la connexion</button> : null}
          {state.status !== "disconnected" ? <button className="btn small" onClick={refresh} disabled={busy !== null}>Vérifier l&apos;identité / la connexion</button> : null}
          {state.status !== "disconnected" ? <button className="btn small danger" onClick={disconnect} disabled={busy !== null}>Déconnecter</button> : null}
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>3–9. Tests de lecture (aucune écriture possible)</h2>
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button className="btn small" onClick={() => read("list_recent", "5 derniers emails")} disabled={!connected || busy !== null}>3. 5 derniers emails</button>
          <button className="btn small" onClick={() => read("list_events", "Calendrier (14 jours)")} disabled={!connected || busy !== null}>8. Calendrier</button>
          <button className="btn small" onClick={loadTools} disabled={busy !== null}>9. Tools disponibles (diagnostic WRITE = 0)</button>
        </div>
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="q">4. Rechercher par texte</label>
          <div className="row">
            <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ex. devis Julien" />
            <button className="btn small" onClick={() => read("search", `Recherche « ${query} »`)} disabled={!connected || busy !== null || !query.trim()}>Rechercher</button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="mid">5–6. Identifiant de message (issu d&apos;un résultat ci-dessus)</label>
          <div className="row">
            <input id="mid" value={messageId} onChange={(e) => setMessageId(e.target.value)} placeholder="id du message" />
            <button className="btn small" onClick={() => read("get_message", "Détails du message")} disabled={!connected || busy !== null || !messageId.trim()}>5. Détails</button>
            <button className="btn small" onClick={() => read("list_attachments", "Pièces jointes")} disabled={!connected || busy !== null || !messageId.trim()}>6. Pièces jointes</button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="aid">7. Identifiant de pièce jointe</label>
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
            <h3>Résumé du diagnostic</h3>
            <p>
              <span className={`badge ${writeFailure ? "danger" : "ok"}`}>WRITE tools executable = {tools.summary.writeToolsExecutable}</span>{" "}
              <span className="muted">exécutables : {tools.summary.executable} · lecture non retenue : {tools.summary.readOnlyUnused} · écriture/destructifs refusés : {tools.summary.blocked}{writeFailure ? " · POC EN ÉCHEC" : ""}</span>
            </p>
            <h3>Exécutables (table déterministe, lecture) — {tools.allowed.length}</h3>
            <ul>{tools.allowed.map((t) => <li key={t.slug}><code>{t.slug}</code> <span className="muted">({t.parameters.join(", ") || "sans paramètre"}{t.required.length ? ` — requis : ${t.required.join(", ")}` : ""})</span></li>)}</ul>
            <h3>Lecture non retenue (non exécutables) — {tools.readOnlyUnused.length}</h3>
            <ul>{tools.readOnlyUnused.map((t) => <li key={t.slug}><code>{t.slug}</code></li>)}</ul>
            <h3>Écriture / destructifs refusés — {tools.blocked.length}</h3>
            <ul>{tools.blocked.map((t) => <li key={t.slug}><code>{t.slug}</code></li>)}</ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
