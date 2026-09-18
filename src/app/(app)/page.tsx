import Link from "next/link";
import { Card, Empty, Stat, CategoryBadge, UrgencyBadge } from "@/components/ui";
import { getDb } from "@/database/connection";
import { requireSessionUser } from "@/security/auth";
import { countEmails } from "@/database/repositories/emails";
import { analysisStats, listEmailsWithAnalysis } from "@/database/repositories/analyses";
import { listActions } from "@/database/repositories/actions";
import { listFollowups, followupStats } from "@/database/repositories/followups";
import { llmUsageSince } from "@/database/repositories/llm-runs";
import { documentStats } from "@/database/repositories/documents";
import { getSettings } from "@/lib/config";
import { startOfTodayIso, formatTime, formatAmount, formatDateTime } from "@/lib/time";
import { dayBounds } from "@/followups/schedule";

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

function analyzedByCategory(list: { category: string | null }[], category: string): number {
  return list.filter((e) => e.category === category).length;
}

function pendingFinancial(db: ReturnType<typeof getDb>, userId: string): number {
  return listActions({ status: "WAITING_APPROVAL", limit: 200, userId }, db).filter((a) => a.type === "forward_email" || a.type === "payment_request" || a.type === "deposit_request").length;
}

export default async function TodayPage() {
  const db = getDb();
  const user = await requireSessionUser(db);
  const settings = getSettings();
  const tz = settings.company.timezone;
  const since = startOfTodayIso();
  const received = countEmails({ since, userId: user.id }, db);
  const stats = analysisStats(since, db);
  const usage = llmUsageSince(since, db);
  const docs = documentStats(since, db);
  const financialPending = pendingFinancial(db, user.id);
  const pending = listActions({ status: "WAITING_APPROVAL", limit: 50, userId: user.id }, db);
  const bounds = dayBounds(tz);
  const followupCounts = followupStats(bounds.start, bounds.end, db);
  const followupsToday = listFollowups({ userId: user.id, status: ["SCHEDULED", "CHECK_FAILED", "CHECKING", "REMINDED"], dueBefore: bounds.end, limit: 20 }, db);
  const followupsWaiting = listFollowups({ userId: user.id, status: "WAITING_APPROVAL", limit: 20 }, db);
  const followupsAnswered = listFollowups({ userId: user.id, status: "RESPONSE_RECEIVED", limit: 20 }, db).filter((f) => (f.updated_at ?? f.created_at) >= bounds.start);
  const followupsAttention = listFollowups({ userId: user.id, status: ["MAX_ATTEMPTS_REACHED", "REVIEW_REQUIRED", "FAILED"], limit: 20 }, db);
  const analyzed = listEmailsWithAnalysis({ since, limit: 200, userId: user.id }, db).filter((e) => e.category !== null);
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
        <Stat label="Relances du jour" value={followupCounts.today} tone={followupCounts.today ? "warn" : undefined} />
      </div>
      <div className="grid grid-4">
        <Stat label="Factures reçues aujourd'hui" value={docs.invoices} />
        <Stat label="Demandes de paiement / acomptes" value={(analyzedByCategory(analyzed, "PAYMENT_REQUEST") + analyzedByCategory(analyzed, "DEPOSIT_REQUEST"))} tone={analyzedByCategory(analyzed, "PAYMENT_REQUEST") + analyzedByCategory(analyzed, "DEPOSIT_REQUEST") ? "warn" : undefined} />
        <Stat label="Documents à vérifier" value={docs.toReview} tone={docs.toReview ? "warn" : undefined} />
        <Stat label="Doublons potentiels" value={docs.duplicates} tone={docs.duplicates ? "danger" : undefined} />
      </div>
      {docs.bankChanges ? <div className="alert danger">⚠️ {docs.bankChanges} document(s) annonçant un changement de coordonnées bancaires — vérification humaine requise, aucune action financière.</div> : null}
      {financialPending ? <div className="alert info">{financialPending} action(s) financière(s) administrative(s) à valider (transfert de facture, demande de règlement). <Link href="/a-valider">Voir</Link></div> : null}
      {stats.failed ? <div className="alert danger">{stats.failed} analyse(s) en échec aujourd&apos;hui : ouvrir l&apos;email puis « Réanalyser ».</div> : null}

      <div className="grid grid-4">
        <Stat label="Relances à valider" value={followupCounts.waitingApproval} tone={followupCounts.waitingApproval ? "warn" : undefined} />
        <Stat label="Réponses reçues (relances annulées)" value={followupCounts.responded} tone={followupCounts.responded ? "ok" : undefined} />
        <Stat label="Suivis sans réponse" value={followupCounts.needsAttention} tone={followupCounts.needsAttention ? "danger" : undefined} />
        <Stat label="Rappels internes" value={followupCounts.reminders} />
      </div>
      {followupsToday.length || followupsWaiting.length || followupsAnswered.length || followupsAttention.length ? (
        <Card title="Relances et rappels" actions={<Link className="btn small" href="/relances">Voir les relances</Link>}>
          {followupsWaiting.map((f) => (
            <div className="priority" key={f.id}>
              <span className="dot orange" />
              <div style={{ flex: 1 }}><strong>Relance à valider</strong> — {f.recipient ?? f.reason} <span className="muted">({f.attempts + 1}/{f.max_attempts})</span></div>
              <Link className="btn small primary" href="/a-valider">Valider</Link>
            </div>
          ))}
          {followupsAttention.map((f) => (
            <div className="priority" key={f.id}>
              <span className="dot red" />
              <div style={{ flex: 1 }}><strong>{f.status === "MAX_ATTEMPTS_REACHED" ? "Suivi sans réponse" : f.status === "REVIEW_REQUIRED" ? "Relance à vérifier" : "Préparation échouée"}</strong> — {f.recipient ?? f.reason}</div>
              <Link className="btn small" href="/relances">Traiter</Link>
            </div>
          ))}
          {followupsToday.map((f) => (
            <div className="priority" key={f.id}>
              <span className={`dot ${f.kind === "INTERNAL_REMINDER" ? "green" : "orange"}`} />
              <div style={{ flex: 1 }}><strong>{f.kind === "INTERNAL_REMINDER" ? "Rappel" : "Relance prévue"}</strong> — {f.title ?? f.reason} <span className="muted">{f.recipient ? `· ${f.recipient}` : ""}</span></div>
              <span className="muted">{formatDateTime(f.execute_at, tz)}</span>
              <Link className="btn small" href="/relances">Voir</Link>
            </div>
          ))}
          {followupsAnswered.map((f) => (
            <div className="priority" key={f.id}>
              <span className="dot green" />
              <div style={{ flex: 1 }}><strong>Réponse reçue</strong> — relance annulée automatiquement {f.recipient ? <span className="muted">({f.recipient})</span> : null}</div>
              {f.last_reply_email_id ? <Link className="btn small" href={`/emails/${f.last_reply_email_id}`}>Voir</Link> : null}
            </div>
          ))}
        </Card>
      ) : null}

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
