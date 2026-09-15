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
const SIGN_STEPS = ["Bon pour accord", "Date", "Signature", "Tampon", "Retour par email dans le thread"];
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
        {a.type === "sign_document" ? <p style={{ marginTop: "0.5rem" }}><span className="muted">Action :</span> {SIGN_STEPS.join(" → ")}</p> : null}
        {draft ? <p className="muted" style={{ marginTop: "0.75rem" }}>Réponse proposée :</p> : null}
        <ApprovalCard
          actionId={a.id}
          actionStatus={a.status}
          approvalStatus={approval?.status ?? null}
          notified={Boolean(approval?.external_message_id) && approval?.status === "PENDING"}
          notifyError={approval?.status === "PENDING" ? approval.last_notify_error : null}
          draft={draft}
          editable={DRAFT_TYPES.has(a.type)}
          actionError={a.error}
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
