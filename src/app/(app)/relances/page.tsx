import { Card, Empty, StatusBadge } from "@/components/ui";
import { FollowupButtons } from "@/components/followup-buttons";
import { getDb } from "@/database/connection";
import { listFollowups } from "@/database/repositories/followups";
import { getSettings } from "@/lib/config";
import { formatDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default function FollowupsPage() {
  const db = getDb();
  const tz = getSettings().company.timezone;
  const active = listFollowups({ status: ["SCHEDULED", "CHECKING", "WAITING_APPROVAL"] }, db);
  const past = listFollowups({ status: ["COMPLETED", "CANCELLED", "FAILED"], limit: 50 }, db);

  const table = (rows: typeof active, withActions: boolean) => (
    <table>
      <thead><tr><th>Destinataire</th><th>Raison</th><th>Date prévue</th><th>Tentatives</th><th>Statut</th>{withActions ? <th></th> : null}</tr></thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.id}>
            <td>{f.recipient ?? "—"}</td>
            <td>{f.reason}</td>
            <td className="muted">{formatDateTime(f.execute_at, tz)}</td>
            <td>{f.attempts}/{f.max_attempts}</td>
            <td><StatusBadge status={f.status} /></td>
            {withActions ? <td><FollowupButtons followupId={f.id} /></td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <h1>Relances</h1>
      <Card title="Relances programmées">{active.length === 0 ? <Empty>Aucune relance programmée.</Empty> : table(active, true)}</Card>
      <Card title="Relances passées">{past.length === 0 ? <Empty>Aucune relance passée.</Empty> : table(past, false)}</Card>
    </>
  );
}
