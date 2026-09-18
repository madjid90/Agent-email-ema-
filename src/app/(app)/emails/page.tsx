import Link from "next/link";
import { Card, CategoryBadge, ConfidenceBadge, Empty, StatusBadge, UrgencyBadge, actionLabel } from "@/components/ui";
import { getDb } from "@/database/connection";
import { requireSessionUser } from "@/security/auth";
import { listEmailsWithAnalysis, type EmailWithAnalysis } from "@/database/repositories/analyses";
import { getSettings, getCompanies } from "@/lib/config";
import { formatDateTime, formatAmount } from "@/lib/time";
import { getOutlookStatus } from "@/integrations/microsoft";
import { SyncButton } from "@/components/sync-button";
import { ReanalyzeButton } from "@/components/reanalyze-button";

export const dynamic = "force-dynamic";

type Tab = "urgent" | "action" | "done" | "info" | "all";
const TABS: { id: Tab; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "action", label: "Action requise" },
  { id: "done", label: "Traité" },
  { id: "info", label: "Information" },
  { id: "all", label: "Tous" },
];

function belongs(e: EmailWithAnalysis, tab: Tab): boolean {
  switch (tab) {
    case "urgent":
      return e.urgency === "HIGH" || e.urgency === "CRITICAL" || e.category === "URGENT";
    case "action":
      return e.status === "NEW" || e.status === "ANALYZING" || e.status === "ANALYSIS_FAILED" || e.status === "ACTION_PROPOSED" || e.needs_reply === 1 || e.requires_human_review === 1 || (e.recommended_action !== null && e.recommended_action !== "none" && e.recommended_action !== "archive");
    case "done":
      return e.status === "PROCESSED" || (e.status === "ANALYZED" && e.needs_reply !== 1 && e.requires_human_review !== 1 && (e.recommended_action === "none" || e.recommended_action === "archive"));
    case "info":
      return e.category === "INFORMATION" || e.status === "IGNORED";
    case "all":
      return true;
  }
}

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : "action";
  const db = getDb();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const user = await requireSessionUser(db);
  const emails = listEmailsWithAnalysis({ limit: 300, userId: user.id }, db).filter((e) => belongs(e, tab));
  const outlook = getOutlookStatus(db, user.id);

  return (
    <>
      <div className="row between" style={{ marginBottom: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Emails</h1>
        <SyncButton connected={outlook.connected} />
      </div>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {outlook.connected ? `${outlook.accountEmail ?? ""} · dernière synchronisation : ${formatDateTime(outlook.lastSyncAt, tz)} · dernier email : ${formatDateTime(outlook.lastEmailAt, tz)}` : "Outlook non connecté."}
        {outlook.lastSyncError ? ` · erreur : ${outlook.lastSyncError}` : ""}
      </p>
      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t.id} href={`/emails?tab=${t.id}`} className={`tab${t.id === tab ? " active" : ""}`}>{t.label}</Link>
        ))}
      </div>
      <Card>
        {emails.length === 0 ? (
          <Empty>Aucun email dans cette catégorie.{outlook.connected ? " Lancez une synchronisation ou attendez le prochain passage du worker." : " Connectez Outlook depuis le setup."}</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Date</th><th>Expéditeur</th><th>Objet</th><th>Résumé EMA</th><th>Catégorie / urgence</th><th>Société</th><th>Action demandée</th><th>Action recommandée</th><th>Confiance</th><th></th></tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.email_id}>
                  <td className="muted">{formatDateTime(e.received_at, tz)}</td>
                  <td>{e.sender_name ?? e.sender_email ?? "—"}<br /><span className="muted" style={{ fontSize: "0.8rem" }}>{e.sender_email}</span></td>
                  <td><Link href={`/emails/${e.email_id}`}>{e.subject || "(sans objet)"}</Link><br /><StatusBadge status={e.status} /></td>
                  <td className="muted">
                    {e.summary ?? "—"}
                    {e.requires_human_review === 1 ? <><br /><span className="badge warn">Validation humaine requise</span></> : null}
                    {e.needs_reply === 1 ? <> <span className="badge primary">Réponse attendue</span></> : null}
                  </td>
                  <td><CategoryBadge category={e.category} /> <UrgencyBadge urgency={e.urgency} /></td>
                  <td>{e.company_id ? companies.get(e.company_id) ?? e.company_id : e.company_name ? <span className="muted">{e.company_name} (non configurée)</span> : "—"}</td>
                  <td className="muted">{e.requested_action ?? "—"}{e.amount_value !== null ? <><br />{formatAmount(e.amount_value, e.amount_currency ?? "EUR")}</> : null}</td>
                  <td>{actionLabel(e.recommended_action)}{e.reply_draft ? <><br /><span className="muted" style={{ fontSize: "0.8rem" }}>brouillon prêt</span></> : null}</td>
                  <td><ConfidenceBadge confidence={e.confidence} reliable={settings.analysis.reliableThreshold} review={settings.analysis.reviewThreshold} /></td>
                  <td className="stack">
                    <Link className="btn small" href={`/emails/${e.email_id}`}>Voir conversation</Link>
                    {e.status === "ANALYSIS_FAILED" || e.status === "NEW" ? <ReanalyzeButton emailId={e.email_id} label={e.status === "NEW" ? "Analyser" : "Réanalyser"} small /> : null}
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
