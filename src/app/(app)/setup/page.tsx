import { SetupWizard } from "@/components/setup-wizard";
import { getSettings, readConfig } from "@/lib/config";
import { getConfiguredIntegrations, getEnv } from "@/lib/env";
import { getOutlookStatus } from "@/integrations/microsoft";
import { getWhatsappStatus } from "@/integrations/whatsapp";
import { kvGetJson } from "@/database/repositories/kv";
import { getContacts } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ step?: string; error?: string; connected?: string }> }) {
  const { step, error, connected } = await searchParams;
  const env = getEnv();
  const notice = error ? { tone: "danger" as const, text: `Connexion Outlook refusée : ${error}` } : connected ? { tone: "ok" as const, text: "Outlook connecté. Lancez une synchronisation pour vérifier." } : null;
  return (
    <>
      <h1>Configuration d&apos;EMA</h1>
      <SetupWizard
        initialStep={step ?? "company"}
        settings={getSettings()}
        rules={readConfig("rules")}
        companies={readConfig("companies")}
        contacts={getContacts()}
        integrations={getConfiguredIntegrations()}
        outlook={getOutlookStatus()}
        notice={notice}
        whatsapp={getWhatsappStatus()}
        appUrl={env.APP_URL}
        model={env.ANTHROPIC_MODEL}
        completedSteps={kvGetJson<string[]>("setup.completed_steps", [])}
      />
    </>
  );
}
