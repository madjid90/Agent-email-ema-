import Link from "next/link";
import { Card, ConfidenceBadge, Empty, RiskBadge } from "@/components/ui";
import { ApprovalCard } from "@/components/approval-card";
import { getDb } from "@/database/connection";
import { listActions } from "@/database/repositories/actions";
import { getLatestApprovalForAction } from "@/database/repositories/approvals";
import { getEmail } from "@/database/repositories/emails";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { getDocument } from "@/database/repositories/documents";
import { getCompanies, getSettings } from "@/lib/config";
import { formatAmount, formatDateTime } from "@/lib/time";
import { parseJson } from "@/database/types";
import { isWhatsappConfigured } from "@/integrations/whatsapp";
import type { ActionRow } from "@/database/types";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  reply_email: "Réponse email",
  forward_email: "Transfert",
  send_email: "Envoi d'email",
  payment_request: "Demande de règlement",
  deposit_request: "Demande d'acompte",
  sign_document: "Signature + tampon",
  send_followup: "Relance",
  prepare_reply: "Brouillon",
  archive: "Archivage",
};
import { formatDateOnly } from "@/lib/time";
const DRAFT_TYPES = new Set(["reply_email", "send_email", "payment_request", "deposit_request", "send_followup"]);

export default function ApprovalsPage() {
  const db = getDb();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const whatsapp = isWhatsappConfigured();
  const pending = listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: 100 }, db);
  const recent = listActions({ status: ["APPROVED", "EXECUTING", "COMPLETED", "REJECTED", "FAILED"], limit: 30 }, db).filter((a) => a.type !== "prepare_reply");

  const renderAction = (a: ActionRow) => {
    const payload = parseJson<Record<string, unknown>>(a.payload, {});
    const email = a.source_email_id ? getEmail(a.source_email_id, db) : undefined;
    const analysis = email ? getLatestAnalysis(email.id, db) : undefined;
    const approval = getLatestApprovalForAction(a.id, db);
    const doc = a.document_id ? getDocument(a.document_id, db) : undefined;
    const amount = typeof payload.amount === "number" ? payload.amount : analysis?.amount_value ?? null;
    const currency = typeof payload.currency === "string" ? payload.currency : analysis?.amount_currency ?? "EUR";
    const draft = typeof payload.body === "string" ? payload.body : typeof payload.reply_body === "string" ? payload.reply_body : null;
    if (a.type === "sign_document") DRAFT_TYPES.add("sign_document");
    const to = Array.isArray(payload.to) ? (payload.to as string[]).join(", ") : null;
    const companyId = a.company_id ?? analysis?.company_id ?? null;
    return (
      <Card key={a.id} title={`${TYPE_LABEL[a.type] ?? a.type} — ${a.title}`} actions={<span className="row"><RiskBadge level={a.risk_level} />{analysis ? <ConfidenceBadge confidence={analysis.confidence} reliable={settings.analysis.reliableThreshold} review={settings.analysis.reviewThreshold} /> : null}</span>}>
        <div className="form-grid">
          <p><span className="muted">Créée :</span> {formatDateTime(a.created_at, tz)}</p>
          <p><span className="muted">Société :</span> {companyId ? companies.get(companyId) ?? companyId : analysis?.company_name ?? "—"}</p>
          {email ? <p><span className="muted">Expéditeur :</span> {email.sender_name ?? "—"} {email.sender_email ? `<${email.sender_email}>` : ""}</p> : null}
          {email ? <p><span className="muted">Objet :</span> <Link href={`/emails/${email.id}`}>{email.subject || "(sans objet)"}</Link></p> : null}
          {amount !== null ? <p><span className="muted">Montant :</span> {formatAmount(amount, currency)}</p> : null}
          {to ? <p><span className="muted">Destinataire :</span> {to}</p> : null}
          {doc ? <p><span className="muted">Document :</span> <Link href={`/documents/${doc.id}`}>{doc.name}</Link>{doc.supplier_name ? ` — ${doc.supplier_name}` : ""}{doc.invoice_number ? ` n° ${doc.invoice_number}` : ""}{doc.amount_incl_tax !== null ? ` — ${formatAmount(doc.amount_incl_tax, doc.currency ?? "EUR")} TTC` : ""}{doc.due_date ? ` — échéance ${doc.due_date}` : ""}</p> : null}
          {doc?.possible_duplicate === 1 ? <p><span className="badge danger">Doublon potentiel</span></p> : null}
          {doc?.bank_details_change === 1 ? <p><span className="badge danger">⚠️ Changement RIB détecté</span></p> : null}
          {a.type === "payment_request" || a.type === "deposit_request" ? <p className="muted">⚠️ EMA n&apos;effectuera aucun paiement bancaire : seul un email interne sera envoyé.</p> : null}
          {approval ? <p><span className="muted">Validation :</span> {approval.status}{approval.decided_by ? ` (${approval.decided_by})` : ""}{approval.status === "PENDING" ? ` · expire le ${formatDateTime(approval.expires_at, tz)}` : ""}</p> : null}
        </div>
        {analysis ? <p style={{ marginTop: "0.5rem" }}><span className="muted">EMA a compris :</span> {analysis.summary}{analysis.requires_human_review === 1 ? <span className="badge warn" style={{ marginLeft: "0.5rem" }}>Validation humaine requise</span> : null}</p> : null}
        {a.type === "sign_document" ? (
          <div className="alert info" style={{ marginTop: "0.5rem" }}>
            <strong>DEVIS À SIGNER</strong>
            <div className="form-grid" style={{ marginTop: "0.4rem" }}>
              <p><span className="muted">Document :</span> {doc ? <Link href={`/documents/${doc.id}`}>{doc.name}</Link> : "—"}</p>
              <p><span className="muted">Fournisseur :</span> {typeof payload.supplier_name === "string" ? payload.supplier_name : "—"}</p>
              <p><span className="muted">Référence :</span> {typeof payload.quote_number === "string" ? payload.quote_number : "—"}</p>
              <p><span className="muted">Objet :</span> {typeof payload.subject === "string" ? payload.subject : "—"}</p>
              <p><span className="muted">Montant :</span> {typeof payload.amount_incl_tax === "number" ? `${formatAmount(payload.amount_incl_tax, typeof payload.currency === "string" ? payload.currency : "EUR")} TTC` : <span className="badge warn">Non détecté — vérification recommandée</span>}</p>
              <p><span className="muted">Société :</span> {companyId ? companies.get(companyId) ?? companyId : "—"}</p>
              <p><span className="muted">Validité :</span> {typeof payload.valid_until === "string" ? formatDateOnly(payload.valid_until, tz) : "—"}{payload.quote_expired ? <span className="badge danger" style={{ marginLeft: "0.4rem" }}>⚠️ Devis potentiellement expiré</span> : null}</p>
              <p><span className="muted">Bon pour accord :</span> « {typeof payload.approval_text === "string" ? payload.approval_text : "Bon pour accord"} » + date du jour</p>
              <p><span className="muted">Signature :</span> {typeof payload.signature_label === "string" ? payload.signature_label : "—"}{typeof payload.signer_name === "string" ? ` (${payload.signer_name}${typeof payload.signer_title === "string" ? `, ${payload.signer_title}` : ""})` : ""}</p>
              <p><span className="muted">Tampon :</span> {payload.stamp_required ? `Oui — ${typeof payload.stamp_label === "string" ? payload.stamp_label : ""}` : "Non"}</p>
              <p><span className="muted">Placement :</span> {payload.placement_strategy === "OVERLAY_LAST_PAGE" ? "Dernière page (positions configurées)" : "Page d'approbation ajoutée"}</p>
              <p><span className="muted">Retour :</span> {typeof payload.reply_to === "string" ? payload.reply_to : email?.sender_email ?? "—"}</p>
            </div>
            {Array.isArray(payload.warnings) && (payload.warnings as string[]).length ? <ul style={{ marginTop: "0.4rem" }}>{(payload.warnings as string[]).map((w) => <li key={w} className="muted">⚠️ {w}</li>)}</ul> : null}
            <p className="muted" style={{ marginTop: "0.4rem", fontSize: "0.85rem" }}>Signature graphique enregistrée appliquée sur une copie ; l&apos;original reste inchangé. Ce n&apos;est pas une signature électronique qualifiée.</p>
          </div>
        ) : null}
        {draft ? <p className="muted" style={{ marginTop: "0.75rem" }}>Réponse proposée :</p> : null}
        <ApprovalCard
          sign={a.type === "sign_document" ? { signedDocumentId: doc?.signed_document_id ?? null, sentTo: typeof payload.reply_to === "string" ? payload.reply_to : email?.sender_email ?? null, completedAt: a.completed_at ? formatDateTime(a.completed_at, tz) : null } : null}
          actionId={a.id}
          actionStatus={a.status}
          approvalStatus={approval?.status ?? null}
          notified={Boolean(approval?.external_message_id) && approval?.status === "PENDING"}
          notifyError={approval?.status === "PENDING" ? approval.last_notify_error : null}
          draft={draft}
          editable={DRAFT_TYPES.has(a.type)}
          actionError={a.error}
          ambiguous={a.error_code === "DELIVERY_AMBIGUOUS"}
          documentId={a.document_id}
          whatsappConfigured={whatsapp}
        />
      </Card>
    );
  };

  return (
    <>
      <h1>À valider</h1>
      {!whatsapp ? <div className="alert warn">WhatsApp n&apos;est pas configuré : les validations se font depuis cette page. <Link href="/setup?step=whatsapp">Configurer WhatsApp</Link>.</div> : null}
      {pending.length === 0 ? <Empty>Aucune action en attente de validation.</Empty> : pending.map(renderAction)}
      {recent.length ? (
        <>
          <h2>Décisions récentes</h2>
          {recent.map(renderAction)}
        </>
      ) : null}
    </>
  );
}
