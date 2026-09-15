import Link from "next/link";
import { Card, CategoryBadge, Empty, StatusBadge, UrgencyBadge } from "@/components/ui";
import { getDb } from "@/database/connection";
import { listEmailsWithAnalysis, type EmailWithAnalysis } from "@/database/repositories/analyses";
import { getSettings, getCompanies } from "@/lib/config";
import { formatDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

type Tab = "urgent" | "action" | "done" | "info";
const TABS: { id: Tab; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "action", label: "Action requise" },
  { id: "done", label: "Traité" },
  { id: "info", label: "Information" },
];

function belongs(e: EmailWithAnalysis, tab: Tab): boolean {
  switch (tab) {
    case "urgent":
      return e.urgency === "high" || e.urgency === "critical" || e.category === "urgent";
    case "action":
      return e.status === "ACTION_PROPOSED" || e.status === "NEW" || e.status === "ANALYZED";
    case "done":
      return e.status === "PROCESSED";
    case "info":
      return e.category === "information" || e.status === "IGNORED";
  }
}

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : "action";
  const db = getDb();
  const tz = getSettings().company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const emails = listEmailsWithAnalysis({ limit: 300 }, db).filter((e) => belongs(e, tab));

  return (
    <>
      <h1>Emails</h1>
      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t.id} href={`/emails?tab=${t.id}`} className={`tab${t.id === tab ? " active" : ""}`}>{t.label}</Link>
        ))}
      </div>
      <Card>
        {emails.length === 0 ? (
          <Empty>Aucun email dans cette catégorie. La synchronisation Outlook arrive en phase 1.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Date</th><th>Expéditeur</th><th>Objet</th><th>Résumé EMA</th><th>Catégorie</th><th>Société</th><th>Action proposée</th><th>Confiance</th><th></th></tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.email_id}>
                  <td className="muted">{formatDateTime(e.received_at, tz)}</td>
                  <td>{e.sender_name ?? e.sender_email ?? "—"}<br /><span className="muted" style={{ fontSize: "0.8rem" }}>{e.sender_email}</span></td>
                  <td>{e.subject}</td>
                  <td className="muted">{e.summary ?? "—"}</td>
                  <td><CategoryBadge category={e.category} /> <UrgencyBadge urgency={e.urgency} /></td>
                  <td>{e.company_id ? companies.get(e.company_id) ?? e.company_id : "—"}</td>
                  <td>{e.recommended_action ?? "—"} <StatusBadge status={e.status} /></td>
                  <td>{e.confidence !== null ? `${Math.round(e.confidence * 100)} %` : "—"}</td>
                  <td className="row">
                    <Link className="btn small" href={`/emails/${e.email_id}`}>Voir conversation</Link>
                    {e.status === "ACTION_PROPOSED" ? <Link className="btn small primary" href="/a-valider">Valider action</Link> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
