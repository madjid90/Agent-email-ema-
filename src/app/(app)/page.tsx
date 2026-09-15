import Link from "next/link";
import { Card, Empty, Stat } from "@/components/ui";
import { getDb } from "@/database/connection";
import { countEmails } from "@/database/repositories/emails";
import { countAnalysesByCategory, listEmailsWithAnalysis } from "@/database/repositories/analyses";
import { listActions } from "@/database/repositories/actions";
import { listFollowups } from "@/database/repositories/followups";
import { getSettings } from "@/lib/config";
import { startOfTodayIso, formatTime, formatAmount } from "@/lib/time";

export const dynamic = "force-dynamic";

const PRIORITY: Record<string, { dot: string; label: string }> = {
  sign_document: { dot: "red", label: "Devis à signer" },
  deposit_request: { dot: "orange", label: "Acompte demandé" },
  payment_request: { dot: "orange", label: "Demande de règlement" },
  forward_email: { dot: "orange", label: "Facture / email à transmettre" },
  reply_email: { dot: "green", label: "Réponse préparée" },
  send_followup: { dot: "green", label: "Relance préparée" },
  send_email: { dot: "green", label: "Email préparé" },
};

export default function TodayPage() {
  const db = getDb();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const since = startOfTodayIso();
  const analyzedToday = countEmails({ since }, db);
  const byCategory = countAnalysesByCategory(since, db);
  const pending = listActions({ status: "WAITING_APPROVAL", limit: 50 }, db);
  const todayEnd = new Date(new Date(since).getTime() + 86_400_000).toISOString();
  const followupsToday = listFollowups({ status: ["SCHEDULED", "WAITING_APPROVAL"] }, db).filter((f) => f.execute_at >= since && f.execute_at < todayEnd);
  const attention = listEmailsWithAnalysis({ since, limit: 100 }, db).filter((e) => e.urgency === "high" || e.urgency === "critical" || e.status === "ACTION_PROPOSED");

  return (
    <>
      <h1>Aujourd&apos;hui</h1>
      <div className="grid grid-4">
        <Stat label="Emails analysés aujourd'hui" value={analyzedToday} />
        <Stat label="Emails nécessitant attention" value={attention.length} tone={attention.length ? "warn" : undefined} />
        <Stat label="Actions à valider" value={pending.length} tone={pending.length ? "danger" : undefined} />
        <Stat label="Relances du jour" value={followupsToday.length} />
      </div>
      <div className="grid grid-3">
        <Stat label="Factures" value={byCategory.invoice ?? 0} />
        <Stat label="Devis" value={(byCategory.quote ?? 0) + (byCategory.document_to_sign ?? 0)} />
        <Stat label="Urgences" value={byCategory.urgent ?? 0} tone={byCategory.urgent ? "danger" : undefined} />
      </div>

      <Card title="Priorités" actions={<Link className="btn small" href="/a-valider">Tout voir</Link>}>
        {pending.length === 0 ? (
          <Empty>Aucune action en attente. EMA vous préviendra sur WhatsApp dès qu&apos;une validation sera nécessaire.</Empty>
        ) : (
          pending.slice(0, 8).map((a) => {
            const p = PRIORITY[a.type] ?? { dot: "grey", label: a.type };
            const payload = safeParse(a.payload);
            return (
              <div className="priority" key={a.id}>
                <span className={`dot ${p.dot}`} />
                <div style={{ flex: 1 }}>
                  <strong>{p.label}</strong> — {a.title}
                  {typeof payload.amount === "number" ? <span className="muted"> · {formatAmount(payload.amount, typeof payload.currency === "string" ? payload.currency : "EUR")}</span> : null}
                </div>
                <span className="muted">{formatTime(a.created_at, tz)}</span>
                <Link className="btn small primary" href="/a-valider">Valider</Link>
              </div>
            );
          })
        )}
      </Card>

      <Card title="Emails nécessitant attention" actions={<Link className="btn small" href="/emails">Voir les emails</Link>}>
        {attention.length === 0 ? (
          <Empty>Rien d&apos;urgent pour le moment.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Heure</th><th>Expéditeur</th><th>Objet</th><th>Résumé EMA</th></tr>
            </thead>
            <tbody>
              {attention.slice(0, 10).map((e) => (
                <tr key={e.email_id}>
                  <td>{formatTime(e.received_at, tz)}</td>
                  <td>{e.sender_name ?? e.sender_email}</td>
                  <td>{e.subject}</td>
                  <td className="muted">{e.summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
