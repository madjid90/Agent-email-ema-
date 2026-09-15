import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, ConfidenceBadge, DocTypeBadge, RiskBadge, StatusBadge } from "@/components/ui";
import { ReanalyzeButton } from "@/components/reanalyze-button";
import { getDb } from "@/database/connection";
import { getDocument } from "@/database/repositories/documents";
import { getEmail } from "@/database/repositories/emails";
import { listHistory } from "@/database/repositories/history";
import { listActionsForEmail } from "@/database/repositories/actions";
import { readExtraction } from "@/documents/analyze";
import { parseJson } from "@/database/types";
import type { DuplicateMatch } from "@/documents/types";
import { getCompanies, getSettings } from "@/lib/config";
import { formatAmount, formatDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const doc = getDocument(id, db);
  if (!doc) notFound();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const email = doc.email_id ? getEmail(doc.email_id, db) : undefined;
  const x = readExtraction(doc);
  const duplicates = parseJson<DuplicateMatch[]>(doc.duplicate_of, []);
  const actions = (email ? listActionsForEmail(email.id, db) : []).filter((a) => a.document_id === doc.id || a.type === "forward_email" || a.type === "payment_request" || a.type === "deposit_request");
  const events = listHistory({ limit: 200 }, db).filter((h) => h.document_id === doc.id);
  const rules = events.filter((h) => h.event_type === "rule.applied" || h.event_type === "action.blocked" || h.event_type === "signature.blocked");
  const signed = doc.signed_document_id ? getDocument(doc.signed_document_id, db) : undefined;
  const parent = doc.parent_document_id ? getDocument(doc.parent_document_id, db) : undefined;
  const signAction = doc.signed_action_id ? actions.find((a) => a.id === doc.signed_action_id) ?? null : null;

  return (
    <>
      <p><Link href="/documents">← Documents</Link></p>
      <h1>{doc.name}</h1>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <DocTypeBadge type={doc.doc_type} />
        <ConfidenceBadge confidence={doc.doc_confidence} reliable={settings.analysis.reliableThreshold} review={settings.analysis.reviewThreshold} />
        <a className="btn small" href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer">Ouvrir le PDF</a>
        {doc.mime_type === "application/pdf" ? <ReanalyzeButton emailId={doc.id} endpoint={`/api/documents/${doc.id}/analyze`} label={doc.analyzed_at ? "Réanalyser le document" : "Analyser le document"} small /> : null}
      </div>
      {doc.bank_details_change === 1 ? <div className="alert danger">⚠️ Changement de coordonnées bancaires détecté — vérification humaine requise. Aucune action financière n&apos;a été proposée.</div> : null}
      {doc.possible_duplicate === 1 ? <div className="alert danger">Doublon potentiel : {duplicates.map((d) => <span key={d.document_id}><Link href={`/documents/${d.document_id}`}>{d.name}</Link> ({d.reasons.join(", ")}) </span>)}</div> : null}
      {doc.text_status === "no_text" ? <div className="alert warn">PDF sans texte exploitable (document scanné ?) : lecture humaine nécessaire, aucune donnée n&apos;a été inventée.</div> : null}
      {doc.analysis_error ? <div className="alert danger">Analyse échouée : {doc.analysis_error}</div> : null}
      {doc.requires_human_review === 1 && doc.bank_details_change !== 1 && doc.possible_duplicate !== 1 ? <div className="alert warn">Vérification humaine requise{x?.warnings.length ? ` : ${x.warnings.join(" · ")}` : ""}.</div> : null}

      {doc.doc_type === "QUOTE" || parent ? (
        <Card title="Signature du devis">
          <ol style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li>Document original : {parent ? <Link href={`/documents/${parent.id}`}>{parent.name}</Link> : <strong>{doc.name}</strong>} <span className="muted">(empreinte {(parent ?? doc).sha256?.slice(0, 12) ?? "—"}…, jamais modifié)</span></li>
            <li>Analyse : {(parent ?? doc).analyzed_at ? `analysé le ${formatDateTime((parent ?? doc).analyzed_at, tz)}` : "non analysée"}</li>
            <li>Action de signature : {signAction ? <><StatusBadge status={signAction.status} /> <span className="muted">{signAction.title}</span></> : doc.signed_action_id ? doc.signed_action_id : "aucune"}</li>
            <li>Validation : {doc.signed_approval_id ? `approval ${doc.signed_approval_id}` : "—"}</li>
            <li>Document signé : {signed ? <><Link href={`/documents/${signed.id}`}>{signed.name}</Link> · <a href={`/api/documents/${signed.id}/file`} target="_blank" rel="noreferrer">ouvrir</a> <span className="muted">(empreinte {signed.sha256?.slice(0, 12)}…, signé le {formatDateTime(signed.signed_at, tz)})</span></> : parent ? <strong>ce document</strong> : "—"}</li>
            <li>Retour Outlook : {(parent ?? doc).sent_at ? `envoyé le ${formatDateTime((parent ?? doc).sent_at, tz)}` : "—"}</li>
          </ol>
          <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>Signature graphique enregistrée (bon pour accord, date, signature, tampon) apposée sur une copie. Ce n&apos;est pas une signature électronique qualifiée.</p>
        </Card>
      ) : null}

      <Card title="Informations extraites">
        {x ? (
          <>
            <p>{x.summary}</p>
            <div className="form-grid" style={{ marginTop: "0.75rem" }}>
              <p><span className="muted">Fournisseur :</span> {x.supplier_name ?? "—"}{x.supplier_email ? ` <${x.supplier_email}>` : ""}</p>
              <p><span className="muted">Client / société :</span> {doc.company_id ? companies.get(doc.company_id) ?? doc.company_id : x.customer_company_name ? `${x.customer_company_name} (non configurée)` : "—"}</p>
              <p><span className="muted">N° :</span> {x.invoice_number ?? x.quote_number ?? "—"}</p>
              {x.document_type === "QUOTE" ? <p><span className="muted">Validité :</span> {x.valid_until ?? "—"}{doc.valid_until && x.warnings.some((w) => w.startsWith("QUOTE_EXPIRED")) ? <span className="badge danger" style={{ marginLeft: "0.4rem" }}>⚠️ Devis potentiellement expiré</span> : null}</p> : null}
              {x.subject ? <p><span className="muted">Objet :</span> {x.subject}</p> : null}
              <p><span className="muted">Bon de commande :</span> {x.purchase_order_number ?? "—"}</p>
              <p><span className="muted">Date :</span> {x.invoice_date ?? "—"}</p>
              <p><span className="muted">Échéance :</span> {x.due_date ?? "—"}</p>
              <p><span className="muted">Montant HT :</span> {x.amount_excl_tax !== null ? formatAmount(x.amount_excl_tax, x.currency ?? "EUR") : "—"}</p>
              <p><span className="muted">TVA :</span> {x.vat_amount !== null ? formatAmount(x.vat_amount, x.currency ?? "EUR") : "—"}</p>
              <p><span className="muted">Montant TTC :</span> {x.amount_incl_tax !== null ? formatAmount(x.amount_incl_tax, x.currency ?? "EUR") : "—"}</p>
              {x.deposit_amount !== null || x.deposit_percent !== null ? <p><span className="muted">Acompte :</span> {x.deposit_amount !== null ? formatAmount(x.deposit_amount, x.currency ?? "EUR") : ""}{x.deposit_percent !== null ? ` (${x.deposit_percent} %)` : ""}{x.total_amount !== null ? ` sur ${formatAmount(x.total_amount, x.currency ?? "EUR")}` : ""}</p> : null}
              <p><span className="muted">IBAN :</span> {x.iban_present ? `présent (…${x.iban_last4 ?? "????"})` : "absent"}</p>
              <p><span className="muted">Référence de paiement :</span> {x.payment_reference ?? "—"}</p>
              <p><span className="muted">Pages / texte :</span> {doc.text_pages ?? "?"} · {doc.text_status}</p>
              <p><span className="muted">Empreinte :</span> <code>{doc.sha256?.slice(0, 16) ?? "—"}…</code></p>
            </div>
            {x.warnings.length ? <ul style={{ marginTop: "0.5rem" }}>{x.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul> : null}
            <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>Analysé le {formatDateTime(doc.analyzed_at, tz)}</p>
          </>
        ) : (
          <p className="muted">{doc.analyzed_at ? "Aucune donnée structurée (document sans texte ou non pris en charge)." : "Pas encore analysé."}</p>
        )}
      </Card>

      <Card title="Email source">
        {email ? <p><Link href={`/emails/${email.id}`}>{email.subject || "(sans objet)"}</Link> — {email.sender_name ?? email.sender_email} · {formatDateTime(email.received_at, tz)}</p> : <p className="muted">—</p>}
      </Card>

      <Card title="Règles et action proposée">
        {rules.length === 0 && actions.length === 0 ? <p className="muted">Aucune règle appliquée, aucune action.</p> : null}
        {rules.map((h) => <p key={h.id} className="muted">{h.message}</p>)}
        {actions.length ? (
          <table style={{ marginTop: "0.5rem" }}>
            <thead><tr><th>Action</th><th>Risque</th><th>Statut</th><th>Créée</th></tr></thead>
            <tbody>{actions.map((a) => <tr key={a.id}><td>{a.title}</td><td><RiskBadge level={a.risk_level} /></td><td><StatusBadge status={a.status} /></td><td className="muted">{formatDateTime(a.created_at, tz)}</td></tr>)}</tbody>
          </table>
        ) : null}
        {actions.some((a) => a.status === "WAITING_APPROVAL") ? <p style={{ marginTop: "0.5rem" }}><Link className="btn small primary" href="/a-valider">Aller à À valider</Link></p> : null}
      </Card>

      <Card title="Historique">
        <ul className="timeline">{events.map((h) => <li key={h.id}><time>{formatDateTime(h.at, tz)}</time><span>{h.message}</span></li>)}</ul>
      </Card>
    </>
  );
}
