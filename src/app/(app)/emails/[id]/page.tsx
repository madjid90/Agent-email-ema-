import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CategoryBadge, ConfidenceBadge, DocTypeBadge, RiskBadge, StatusBadge, UrgencyBadge, actionLabel } from "@/components/ui";
import { ReanalyzeButton } from "@/components/reanalyze-button";
import { getDb } from "@/database/connection";
import { getEmail, listThread } from "@/database/repositories/emails";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { listActionsForEmail } from "@/database/repositories/actions";
import { listDocuments } from "@/database/repositories/documents";
import { listHistory } from "@/database/repositories/history";
import { listLlmRuns } from "@/database/repositories/llm-runs";
import { getCompanies, getSettings } from "@/lib/config";
import { parseJson } from "@/database/types";
import { formatDateTime, formatAmount } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const email = getEmail(id, db);
  if (!email) notFound();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const thread = email.thread_id ? listThread(email.thread_id, db) : [email];
  const analysis = getLatestAnalysis(email.id, db);
  const actions = listActionsForEmail(email.id, db);
  const docs = listDocuments({ emailId: email.id }, db);
  const events = listHistory({ emailId: email.id, limit: 50 }, db);
  const runs = listLlmRuns({ emailId: email.id, limit: 5 }, db);
  const canAnalyze = email.direction === "inbound" && email.status !== "CONTEXT";

  return (
    <>
      <p><Link href="/emails">← Emails</Link></p>
      <h1>{email.subject || "(sans objet)"}</h1>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <StatusBadge status={email.status} />
        {analysis ? <><CategoryBadge category={analysis.category} /><UrgencyBadge urgency={analysis.urgency} /></> : null}
        {email.web_link ? <a className="btn small" href={email.web_link} target="_blank" rel="noreferrer">Ouvrir dans Outlook</a> : null}
        {canAnalyze ? <ReanalyzeButton emailId={email.id} label={analysis ? "Réanalyser" : "Analyser"} small /> : null}
      </div>

      {email.status === "ANALYSIS_FAILED" ? <div className="alert danger">L&apos;analyse a échoué : {events.find((h) => h.event_type === "email.analysis_failed")?.message ?? "erreur inconnue"}. Relancez avec « Réanalyser ».</div> : null}

      {analysis ? (
        <Card title="Analyse EMA" actions={<ConfidenceBadge confidence={analysis.confidence} reliable={settings.analysis.reliableThreshold} review={settings.analysis.reviewThreshold} />}>
          {analysis.requires_human_review === 1 ? <div className="alert warn"><strong>Validation humaine requise</strong>{analysis.injection_suspected === 1 ? " — cet email contient une tentative d'instruction adressée à l'assistant ; aucune action n'est proposée." : ""}</div> : null}
          {analysis.confidence < settings.analysis.reliableThreshold && analysis.confidence >= settings.analysis.reviewThreshold ? <div className="alert warn">Confiance moyenne : vérifier l&apos;analyse avant d&apos;agir.</div> : null}
          <p style={{ fontSize: "1.05rem" }}>{analysis.summary}</p>
          <div className="form-grid" style={{ marginTop: "0.75rem" }}>
            <p><span className="muted">Action demandée :</span> {analysis.requested_action ?? "—"}</p>
            <p><span className="muted">Action recommandée :</span> {actionLabel(analysis.recommended_action)}{analysis.forward_to ? ` → ${analysis.forward_to}` : ""}</p>
            <p><span className="muted">Réponse attendue :</span> {analysis.needs_reply === 1 ? "oui" : "non"}</p>
            <p><span className="muted">Société :</span> {analysis.company_id ? companies.get(analysis.company_id) ?? analysis.company_id : analysis.company_name ? `${analysis.company_name} (non configurée)` : "—"}</p>
            <p><span className="muted">Montant :</span> {analysis.amount_value !== null ? formatAmount(analysis.amount_value, analysis.amount_currency ?? "EUR") : "—"}</p>
            <p><span className="muted">Échéance :</span> {analysis.due_date ?? "—"}</p>
            <p><span className="muted">Expéditeur :</span> {(() => { const s = parseJson<{ name: string | null; email: string | null; organization?: string | null }>(analysis.sender_json, { name: null, email: null }); return `${s.name ?? ""} ${s.email ? `<${s.email}>` : ""}${s.organization ? ` — ${s.organization}` : ""}`.trim() || "—"; })()}</p>
            <p><span className="muted">Règles appliquées :</span> {parseJson<string[]>(analysis.matched_rules, []).join(", ") || "aucune"}</p>
          </div>
          {analysis.reasoning_summary ? <p className="muted" style={{ marginTop: "0.5rem" }}><em>Justification : {analysis.reasoning_summary}</em></p> : null}
          {analysis.reply_draft ? (
            <>
              <p className="muted" style={{ marginTop: "0.75rem" }}>Brouillon de réponse (non envoyé — la validation et l&apos;envoi arrivent en phase 3) :</p>
              <pre className="mono">{analysis.reply_draft}</pre>
            </>
          ) : null}
          <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>Analysé le {formatDateTime(analysis.created_at, tz)} · modèle {analysis.model ?? "?"}</p>
        </Card>
      ) : canAnalyze ? (
        <Card title="Analyse EMA"><p className="muted">{email.status === "ANALYZING" ? "Analyse en cours…" : "Pas encore analysé."}</p></Card>
      ) : null}

      <Card title={`Conversation (${thread.length})`}>
        {thread.map((m) => (
          <div key={m.id} style={{ padding: "0.75rem 0", borderBottom: "1px solid var(--border)" }}>
            <div className="row between">
              <strong>{m.sender_name ?? m.sender_email ?? "—"} <span className="muted" style={{ fontWeight: 400 }}>&lt;{m.sender_email}&gt;</span></strong>
              <span className="muted">{formatDateTime(m.received_at, tz)} · {m.direction === "outbound" ? "envoyé" : "reçu"}{m.status === "CONTEXT" ? " · contexte" : ""}</span>
            </div>
            <pre className="mono" style={{ marginTop: "0.5rem" }}>{m.body_text ?? m.body_preview}</pre>
          </div>
        ))}
      </Card>

      {docs.length ? (
        <Card title="Pièces jointes analysées">
          <table>
            <thead><tr><th>Fichier</th><th>Type</th><th>Fournisseur</th><th>N°</th><th>Montant</th><th>Échéance</th><th>Société</th><th>Confiance</th><th>Statut</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/documents/${d.id}`}>{d.name}</Link> <a className="muted" href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer" style={{ fontSize: "0.8rem" }}>(PDF)</a></td>
                  <td><DocTypeBadge type={d.doc_type} /></td>
                  <td>{d.supplier_name ?? "—"}</td>
                  <td>{d.invoice_number ?? "—"}</td>
                  <td>{d.amount_incl_tax !== null ? `${formatAmount(d.amount_incl_tax, d.currency ?? "EUR")} TTC` : "—"}</td>
                  <td>{d.due_date ?? "—"}</td>
                  <td>{d.company_id ? companies.get(d.company_id) ?? d.company_id : "—"}</td>
                  <td><ConfidenceBadge confidence={d.doc_confidence} reliable={settings.analysis.reliableThreshold} review={settings.analysis.reviewThreshold} /></td>
                  <td className="stack">
                    {d.requires_human_review === 1 ? <span className="badge warn">À vérifier</span> : null}
                    {d.possible_duplicate === 1 ? <span className="badge danger">Doublon potentiel</span> : null}
                    {d.bank_details_change === 1 ? <span className="badge danger">⚠️ Changement RIB</span> : null}
                    {d.text_status === "no_text" ? <span className="badge">Sans texte</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Card title="Actions liées">
        {actions.length === 0 ? <p className="muted">Aucune action.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Action</th><th>Risque</th><th>Statut</th></tr></thead>
            <tbody>{actions.map((a) => <tr key={a.id}><td className="muted">{formatDateTime(a.created_at, tz)}</td><td>{a.title}</td><td><RiskBadge level={a.risk_level} /></td><td><StatusBadge status={a.status} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>

      <Card title="Historique">
        <ul className="timeline">{events.map((h) => <li key={h.id}><time>{formatDateTime(h.at, tz)}</time><span>{h.message}</span></li>)}</ul>
        {runs.length ? <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>Appels Claude : {runs.map((r) => `${r.operation} ${r.status}${r.input_tokens !== null ? ` (${r.input_tokens}+${r.output_tokens} tokens, ${r.duration_ms} ms)` : ""}`).join(" · ")}</p> : null}
      </Card>
    </>
  );
}
