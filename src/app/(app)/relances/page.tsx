import Link from "next/link";
import { Card, Empty, StatusBadge } from "@/components/ui";
import { FollowupButtons } from "@/components/followup-buttons";
import { getDb } from "@/database/connection";
import { listFollowups } from "@/database/repositories/followups";
import type { FollowupRow } from "@/database/types";
import { getSettings } from "@/lib/config";
import { formatDateTime } from "@/lib/time";
import { dayBounds } from "@/followups/schedule";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { EXTERNAL_FOLLOWUP: "Relance", INTERNAL_REMINDER: "Rappel interne" };

export default function FollowupsPage() {
  const db = getDb();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const { end } = dayBounds(tz);
  const active = listFollowups({ status: ["SCHEDULED", "CHECKING", "CHECK_FAILED", "REMINDED"] }, db);
  const today = active.filter((f) => f.execute_at < end);
  const upcoming = active.filter((f) => f.execute_at >= end);
  const waiting = listFollowups({ status: "WAITING_APPROVAL" }, db);
  const attention = listFollowups({ status: ["REVIEW_REQUIRED", "MAX_ATTEMPTS_REACHED", "FAILED"] }, db);
  const sent = listFollowups({ status: ["SENT", "DONE"], limit: 30 }, db);
  const closed = listFollowups({ status: ["CANCELLED", "RESPONSE_RECEIVED", "SUPERSEDED"], limit: 30 }, db);

  const table = (rows: FollowupRow[], withActions: boolean) => (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Contact</th>
          <th>Objet / raison</th>
          <th>Échéance</th>
          <th>Tentative</th>
          <th>Statut</th>
          <th>Dernière réponse</th>
          {withActions ? <th></th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.id}>
            <td className="muted">{KIND_LABEL[f.kind] ?? f.kind}</td>
            <td>{f.recipient ?? "—"}</td>
            <td>
              {f.title ?? f.reason}
              {f.last_error ? <div className="muted">{f.last_error}</div> : null}
              {f.notification_pending === 1 ? <span className="badge warn">Notification en attente</span> : null}
            </td>
            <td className="muted">{formatDateTime(f.execute_at, tz)}</td>
            <td>{f.attempts}/{f.max_attempts}</td>
            <td><StatusBadge status={f.status} /></td>
            <td className="muted">{f.last_reply_email_id ? <Link href={`/emails/${f.last_reply_email_id}`}>Voir la réponse</Link> : "—"}</td>
            {withActions ? (
              <td>
                <FollowupButtons followupId={f.id} kind={f.kind} status={f.status} emailId={f.email_id} actionId={f.generated_action_id} />
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <h1>Relances</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        À l&apos;échéance, EMA relit le thread dans Outlook. Si une réponse est arrivée, la relance est annulée automatiquement ; sinon un brouillon est préparé et soumis à validation. Aucune relance n&apos;est envoyée sans validation.
      </p>
      {attention.length ? (
        <Card title={`À traiter (${attention.length})`}>{table(attention, true)}</Card>
      ) : null}
      <Card title={`En attente de validation (${waiting.length})`}>
        {waiting.length === 0 ? <Empty>Aucune relance en attente de validation.</Empty> : table(waiting, true)}
      </Card>
      <Card title={`Aujourd'hui (${today.length})`}>{today.length === 0 ? <Empty>Aucune relance prévue aujourd&apos;hui.</Empty> : table(today, true)}</Card>
      <Card title={`À venir (${upcoming.length})`}>{upcoming.length === 0 ? <Empty>Aucune relance à venir.</Empty> : table(upcoming, true)}</Card>
      <Card title="Envoyées / terminées">{sent.length === 0 ? <Empty>Aucune relance envoyée.</Empty> : table(sent, false)}</Card>
      <Card title="Annulées / sans objet">{closed.length === 0 ? <Empty>Aucune relance annulée.</Empty> : table(closed, false)}</Card>
    </>
  );
}
