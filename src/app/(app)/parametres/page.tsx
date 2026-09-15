import { Card } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { getSettings } from "@/lib/config";
import { getConfiguredIntegrations, getEnv } from "@/lib/env";
import { getOutlookStatus } from "@/integrations/microsoft";
import { OutlookPanel } from "@/components/outlook-panel";
import { WhatsappPanel } from "@/components/whatsapp-panel";
import { getWhatsappStatus } from "@/integrations/whatsapp";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  const integrations = getConfiguredIntegrations();
  const outlook = getOutlookStatus();
  const whatsapp = getWhatsappStatus();
  const env = getEnv();
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
            {row("Microsoft Graph / Outlook", integrations.microsoft && outlook.connected, outlook.connected ? `connecté : ${outlook.accountEmail ?? ""}` : "non connecté")}
            {row("WhatsApp Business", whatsapp.configured, whatsapp.approverPhone ? `validation par ${whatsapp.approverPhone}` : "numéro autorisé manquant")}
            {row("Secret applicatif (APP_SECRET)", integrations.appSecret)}
            {row("Mot de passe interface (APP_PASSWORD)", integrations.appPassword)}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: "0.75rem" }}>Les secrets se modifient uniquement dans le fichier <code>.env</code> du VPS, jamais depuis l&apos;interface.</p>
      </Card>
      <OutlookPanel status={outlook} timezone={settings.company.timezone} />
      <WhatsappPanel status={whatsapp} appUrl={env.APP_URL} />
      <SettingsForm initial={settings} />
    </>
  );
}
