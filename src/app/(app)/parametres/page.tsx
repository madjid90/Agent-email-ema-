import { Card } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { getSettings } from "@/lib/config";
import { getConfiguredIntegrations, getEnv } from "@/lib/env";
import { getOutlookStatus } from "@/integrations/microsoft";
import { OutlookPanel } from "@/components/outlook-panel";
import { WhatsappPanel } from "@/components/whatsapp-panel";
import { getWhatsappStatus } from "@/integrations/whatsapp";
import { activitySummary, costReport, mb, runChecks, DISK_WARN_RATIO } from "@/lib/diagnostics";
import { formatDateTime } from "@/lib/time";
import pkg from "../../../../package.json";
import { requireSessionUser } from "@/security/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireSessionUser();
  const settings = getSettings();
  const integrations = getConfiguredIntegrations();
  const outlook = getOutlookStatus(undefined, user.id);
  const whatsapp = getWhatsappStatus();
  const env = getEnv();
  const health = runChecks(pkg.version);
  const costs = costReport(7);
  const activity = activitySummary();
  const row = (label: string, ok: boolean, detail?: string) => (
    <tr><td>{label}</td><td><span className={`badge ${ok ? "ok" : "warn"}`}>{ok ? "Configuré" : "À configurer"}</span> {detail ? <span className="muted">{detail}</span> : null}</td></tr>
  );
  return (
    <>
      <h1>Paramètres</h1>
      <Card title="Intégrations (depuis .env)">
        <table>
          <tbody>
            {row("Claude (Anthropic)", integrations.anthropic, `modèle : ${env.ANTHROPIC_MODEL}`)}
            {row("Microsoft Graph / Outlook", integrations.microsoft && outlook.connected, outlook.connected ? `votre boîte : ${outlook.accountEmail ?? ""}` : "votre boîte n'est pas connectée (Connexions)")}
            {row("WhatsApp Business EMA", whatsapp.configured, whatsapp.configured ? "numéro central configuré — activation par utilisateur dans Connexions" : "token / numéro manquants")}
            {row("Secret applicatif (APP_SECRET)", integrations.appSecret)}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: "0.75rem" }}>Les secrets se modifient uniquement dans le fichier <code>.env</code> du VPS, jamais depuis l&apos;interface.</p>
      </Card>
      <Card title={`Diagnostic — ${health.status === "PASS" ? "tout est vert" : health.status === "WARN" ? "à surveiller" : "action requise"}`}>
        {health.disk.totalBytes > 0 && health.disk.freeRatio < DISK_WARN_RATIO ? (
          <div className="alert danger">⚠️ Espace disque faible : {Math.round(health.disk.freeRatio * 100)} % libre. Purger les anciennes sauvegardes ou augmenter le disque du VPS.</div>
        ) : null}
        <table>
          <tbody>
            {health.checks.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td><span className={`badge ${c.level === "PASS" ? "ok" : c.level === "WARN" ? "warn" : "danger"}`}>{c.level}</span> <span className="muted">{c.detail}</span></td>
              </tr>
            ))}
            <tr><td>worker</td><td className="muted">{health.worker.lastHeartbeatAt ? `dernier battement : ${formatDateTime(health.worker.lastHeartbeatAt, settings.company.timezone)}` : "jamais démarré"}</td></tr>
            <tr><td>stockage</td><td className="muted">base {mb(health.disk.databaseBytes)} · private {mb(health.disk.privateBytes)} · sauvegardes {mb(health.disk.backupsBytes)}</td></tr>
            <tr><td>activité</td><td className="muted">{activity.pendingActions} action(s) à valider · {activity.activeFollowups} relance(s) active(s) · {activity.notificationsPending} notification(s) WhatsApp en attente</td></tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: "0.75rem" }}>Diagnostic complet en ligne de commande : <code>npm run doctor</code>. Version {pkg.version}.</p>
      </Card>

      <Card title="Consommation Claude">
        <table>
          <thead><tr><th>Jour</th><th>Appels</th><th>Tokens entrée</th><th>Tokens sortie</th><th>Erreurs</th></tr></thead>
          <tbody>
            {costs.byDay.length === 0 ? <tr><td colSpan={5} className="muted">Aucun appel enregistré.</td></tr> : costs.byDay.map((d) => (
              <tr key={d.day}><td>{d.day}</td><td>{d.runs}</td><td>{d.inputTokens.toLocaleString("fr-FR")}</td><td>{d.outputTokens.toLocaleString("fr-FR")}</td><td>{d.errors}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          Aujourd&apos;hui : {costs.today.runs} appel(s), coût estimé ≈ {costs.today.estimatedCost} {costs.currency} (tarifs configurables dans <code>settings.costs</code>). Estimation locale, hors facturation réelle Anthropic.
        </p>
      </Card>

      <OutlookPanel status={outlook} timezone={settings.company.timezone} />
      <WhatsappPanel status={whatsapp} appUrl={env.APP_URL} />
      <SettingsForm initial={settings} />
    </>
  );
}
