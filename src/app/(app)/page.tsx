import Link from "next/link";
import { Card, Empty, Stat, CategoryBadge, UrgencyBadge } from "@/components/ui";
import { getDb } from "@/database/connection";
import { countEmails } from "@/database/repositories/emails";
import { analysisStats, listEmailsWithAnalysis } from "@/database/repositories/analyses";
import { listActions } from "@/database/repositories/actions";
import { listFollowups } from "@/database/repositories/followups";
import { llmUsageSince } from "@/database/repositories/llm-runs";
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

const RECO_PRIORITY: Record<string, { dot: string; label: string }> = {
  sign_document: { dot: "red", label: "Devis à signer" },
  deposit_request: { dot: "orange", label: "Acompte demandé" },
  payment_request: { dot: "orange", label: "Règlement demandé" },
  forward: { dot: "orange", label: "À transmettre" },
  reply: { dot: "green", label: "Réponse préparée" },
  schedule_followup: { dot: "green", label: "Relance à programmer" },
};

export default function TodayPage() {
  const db = getDb();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const since = startOfTodayIso();
  const received = countEmails({ since }, db);
  const stats = analysisStats(since, db);
  const usage = llmUsageSince(since, db);
  const pending = listActions({ status: "WAITING_APPROVAL", limit: 50 }, db);
  const todayEnd = new Date(new Date(since).getTime() + 86_400_000).toISOString();
  const followupsToday = listFollowups({ status: ["SCHEDULED", "WAITING_APPROVAL"] }, db).filter((f) => f.execute_at >= since && f.execute_at < todayEnd);
  const analyzed = listEmailsWithAnalysis({ since, limit: 200 }, db).filter((e) => e.category !== null);
  const attention = analyzed.filter((e) => e.urgency === "HIGH" || e.urgency === "CRITICAL" || e.requires_human_review === 1 || e.needs_reply === 1);
  const priorities = analyzed
    .filter((e) => e.recommended_action && e.recommended_action !== "none" && e.recommended_action !== "archive")
    .sort((a, b) => Object.keys(RECO_PRIORITY).indexOf(a.recommended_action ?? "") - Object.keys(RECO_PRIORITY).indexOf(b.recommended_action ?? ""));

  return (
    <>
      <h1>Aujourd&apos;hui</h1>
      <div className="grid grid-4">
        <Stat label="Emails reçus aujourd'hui" value={received} />
        <Stat label="Emails analysés" value={stats.analyzed} tone={stats.failed ? "warn" : undefined} />
        <Stat label="Urgences" value={stats.urgent} tone={stats.urgent ? "danger" : undefined} />
        <Stat label="Réponses à envoyer" value={stats.needsReply} tone={stats.needsReply ? "warn" : undefined} />
      </div>
      <div className="grid grid-4">
        <Stat label="Validation humaine requise" value={stats.humanReview} tone={stats.humanReview ? "warn" : undefined} />
        <Stat label="Factures détectées" value={stats.invoices} />
        <Stat label="Devis / documents à signer" value={stats.quotes} />
        <Stat label="Relances du jour" value={followupsToday.length} />
      </div>
      {stats.failed ? <div className="alert danger">{stats.failed} analyse(s) en échec aujourd&apos;hui : ouvrir l&apos;email puis « Réanalyser ».</div> : null}

      <Card title="Priorités" actions={<Link className="btn small" href="/emails">Voir les emails</Link>}>
        {priorities.length === 0 && pending.length === 0 ? (
          <Empty>Aucune priorité pour le moment. Les nouveaux emails sont analysés automatiquement par le worker.</Empty>
        ) : (
          <>
            {priorities.slice(0, 8).map((e) => {
              const p = RECO_PRIORITY[e.recommended_action ?? ""] ?? { dot: "grey", label: e.recommended_action ?? "" };
              return (
                <div className="priority" key={e.email_id}>
                  <span className={`dot ${p.dot}`} />
                  <div style={{ flex: 1 }}>
                    <strong>{p.label}</strong> — {e.subject} <span className="muted">({e.sender_name ?? e.sender_email})</span>
                    {e.amount_value !== null ? <span className="muted"> · {formatAmount(e.amount_value, e.amount_currency ?? "EUR")}</span> : null}
                    {e.requires_human_review === 1 ? <span className="badge warn" style={{ marginLeft: "0.5rem" }}>Validation humaine requise</span> : null}
                  </div>
                  <span className="muted">{formatTime(e.received_at, tz)}</span>
                  <Link className="btn small primary" href={`/emails/${e.email_id}`}>Voir</Link>
                </div>
              );
            })}
            {pending.slice(0, 8).map((a) => {
              const p = PRIORITY[a.type] ?? { dot: "grey", label: a.type };
              return (
                <div className="priority" key={a.id}>
                  <span className={`dot ${p.dot}`} />
                  <div style={{ flex: 1 }}><strong>{p.label}</strong> — {a.title}</div>
                  <span className="muted">{formatTime(a.created_at, tz)}</span>
                  <Link className="btn small primary" href="/a-valider">Valider</Link>
                </div>
              );
            })}
          </>
        )}
      </Card>

      <Card title="Emails nécessitant attention" actions={<Link className="btn small" href="/emails?tab=action">Tout voir</Link>}>
        {attention.length === 0 ? (
          <Empty>Rien d&apos;urgent pour le moment.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Heure</th><th>Expéditeur</th><th>Objet</th><th>Résumé EMA</th><th>Catégorie</th></tr>
            </thead>
            <tbody>
              {attention.slice(0, 10).map((e) => (
                <tr key={e.email_id}>
                  <td>{formatTime(e.received_at, tz)}</td>
                  <td>{e.sender_name ?? e.sender_email}</td>
                  <td><Link href={`/emails/${e.email_id}`}>{e.subject}</Link></td>
                  <td className="muted">{e.summary ?? "—"}</td>
                  <td><CategoryBadge category={e.category} /> <UrgencyBadge urgency={e.urgency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="muted" style={{ fontSize: "0.85rem" }}>Claude aujourd&apos;hui : {usage.runs} appel(s){usage.errors ? `, ${usage.errors} erreur(s)` : ""}, {usage.inputTokens + usage.outputTokens} tokens.</p>
    </>
  );
}
