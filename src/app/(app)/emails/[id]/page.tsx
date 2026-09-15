import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CategoryBadge, RiskBadge, StatusBadge, UrgencyBadge } from "@/components/ui";
import { getDb } from "@/database/connection";
import { getEmail, listThread } from "@/database/repositories/emails";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { listActionsForEmail } from "@/database/repositories/actions";
import { listDocuments } from "@/database/repositories/documents";
import { listHistory } from "@/database/repositories/history";
import { getSettings } from "@/lib/config";
import { formatDateTime, formatAmount } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const email = getEmail(id, db);
  if (!email) notFound();
  const tz = getSettings().company.timezone;
  const thread = email.thread_id ? listThread(email.thread_id, db) : [email];
  const analysis = getLatestAnalysis(email.id, db);
  const actions = listActionsForEmail(email.id, db);
  const docs = listDocuments({ emailId: email.id }, db);
  const events = listHistory({ emailId: email.id, limit: 50 }, db);

  return (
    <>
      <p><Link href="/emails">← Emails</Link></p>
      <h1>{email.subject}</h1>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <StatusBadge status={email.status} />
        {analysis ? <><CategoryBadge category={analysis.category} /><UrgencyBadge urgency={analysis.urgency} /></> : null}
      </div>

      {analysis ? (
        <Card title="Analyse EMA">
          <p>{analysis.summary}</p>
          <div className="form-grid" style={{ marginTop: "0.75rem" }}>
            <p><span className="muted">Demande :</span> {analysis.requested_action ?? "—"}</p>
            <p><span className="muted">Action recommandée :</span> {analysis.recommended_action}</p>
            <p><span className="muted">Montant :</span> {formatAmount(analysis.amount_value, analysis.amount_currency ?? "EUR")} {analysis.amount_tax_mode && analysis.amount_tax_mode !== "unknown" ? analysis.amount_tax_mode : ""}</p>
            <p><span className="muted">Échéance :</span> {analysis.due_date ?? "—"}</p>
            <p><span className="muted">Société :</span> {analysis.company_id ?? "—"}</p>
            <p><span className="muted">Confiance :</span> {Math.round(analysis.confidence * 100)} %</p>
          </div>
        </Card>
      ) : null}

      <Card title={`Conversation (${thread.length})`}>
        {thread.map((m) => (
          <div key={m.id} style={{ padding: "0.75rem 0", borderBottom: "1px solid var(--border)" }}>
            <div className="row between">
              <strong>{m.sender_name ?? m.sender_email ?? "—"} <span className="muted" style={{ fontWeight: 400 }}>&lt;{m.sender_email}&gt;</span></strong>
              <span className="muted">{formatDateTime(m.received_at, tz)} · {m.direction === "outbound" ? "envoyé" : "reçu"}</span>
            </div>
            <pre className="mono" style={{ marginTop: "0.5rem" }}>{m.body_text ?? m.body_preview}</pre>
          </div>
        ))}
      </Card>

      {docs.length ? (
        <Card title="Pièces jointes">
          <ul>{docs.map((d) => <li key={d.id}>{d.name} <span className="muted">({d.mime_type}, {Math.round(d.size / 1024)} Ko)</span> <span className="badge">{d.category}</span></li>)}</ul>
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
      </Card>
    </>
  );
}
