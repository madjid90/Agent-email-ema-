import { Card, Empty, RiskBadge } from "@/components/ui";
import { ActionButtons } from "@/components/action-buttons";
import { getDb } from "@/database/connection";
import { listActions } from "@/database/repositories/actions";
import { getEmail } from "@/database/repositories/emails";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { getDocument } from "@/database/repositories/documents";
import { getCompanies, getSettings } from "@/lib/config";
import { formatAmount, formatDateTime } from "@/lib/time";
import { parseJson } from "@/database/types";

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

export default function ApprovalsPage() {
  const db = getDb();
  const tz = getSettings().company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const pending = listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: 100 }, db);

  return (
    <>
      <h1>À valider</h1>
      {pending.length === 0 ? (
        <Empty>Aucune action en attente de validation.</Empty>
      ) : (
        pending.map((a) => {
          const payload = parseJson<Record<string, unknown>>(a.payload, {});
          const email = a.source_email_id ? getEmail(a.source_email_id, db) : undefined;
          const analysis = email ? getLatestAnalysis(email.id, db) : undefined;
          const doc = a.document_id ? getDocument(a.document_id, db) : undefined;
          const amount = typeof payload.amount === "number" ? payload.amount : analysis?.amount_value ?? null;
          const currency = typeof payload.currency === "string" ? payload.currency : analysis?.amount_currency ?? "EUR";
          const body = typeof payload.body === "string" ? payload.body : typeof payload.reply_body === "string" ? payload.reply_body : null;
          const to = Array.isArray(payload.to) ? (payload.to as string[]).join(", ") : null;
          return (
            <Card key={a.id} title={`${TYPE_LABEL[a.type] ?? a.type} — ${a.title}`} actions={<RiskBadge level={a.risk_level} />}>
              <div className="form-grid">
                <p><span className="muted">Créée :</span> {formatDateTime(a.created_at, tz)}</p>
                <p><span className="muted">Société :</span> {a.company_id ? companies.get(a.company_id) ?? a.company_id : "—"}</p>
                {amount !== null ? <p><span className="muted">Montant :</span> {formatAmount(amount, currency)}</p> : null}
                {to ? <p><span className="muted">Destinataire :</span> {to}</p> : null}
                {email ? <p><span className="muted">Email source :</span> {email.sender_name ?? email.sender_email} — {email.subject}</p> : null}
                {doc ? <p><span className="muted">Document :</span> {doc.name}</p> : null}
              </div>
              {analysis ? <p style={{ marginTop: "0.5rem" }}><span className="muted">EMA a compris :</span> {analysis.summary}</p> : null}
              {a.type === "sign_document" ? (
                <p style={{ marginTop: "0.5rem" }}><span className="muted">Action :</span> {SIGN_STEPS.join(" → ")}</p>
              ) : null}
              {body ? (
                <>
                  <p className="muted" style={{ marginTop: "0.75rem" }}>Réponse / message proposé :</p>
                  <pre className="mono">{body}</pre>
                </>
              ) : null}
              <ActionButtons actionId={a.id} documentId={a.document_id} />
            </Card>
          );
        })
      )}
    </>
  );
}
