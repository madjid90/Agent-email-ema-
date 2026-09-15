import { SetupWizard } from "@/components/setup-wizard";
import { getSettings, readConfig } from "@/lib/config";
import { getConfiguredIntegrations, getEnv } from "@/lib/env";
import { getOutlookStatus } from "@/integrations/microsoft";
import { getWhatsappStatus } from "@/integrations/whatsapp";
import { kvGetJson } from "@/database/repositories/kv";
import { getContacts } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const env = getEnv();
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
        whatsapp={getWhatsappStatus()}
        model={env.ANTHROPIC_MODEL}
        completedSteps={kvGetJson<string[]>("setup.completed_steps", [])}
      />
    </>
  );
}
