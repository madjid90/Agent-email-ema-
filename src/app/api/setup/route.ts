import { route, ok, parseBody, currentUser } from "@/lib/api";
import { getSettings, settingsSchema, writeConfig, getCompanies, getRules } from "@/lib/config";
import { getConfiguredIntegrations } from "@/lib/env";
import { getOutlookStatus } from "@/integrations/microsoft";
import { getWhatsappStatus } from "@/integrations/whatsapp";
import { kvGetJson, kvSetJson } from "@/database/repositories/kv";
import { z } from "zod";

export const GET = route(async (_req, _ctx, sessionUser) => {
  const companies = getCompanies();
  return ok({
    settings: getSettings(),
    integrations: getConfiguredIntegrations(),
    outlook: getOutlookStatus(undefined, currentUser(sessionUser).id),
    whatsapp: getWhatsappStatus(),
    counts: { companies: companies.length, rules: getRules().length, companiesWithAssets: companies.filter((c) => c.signaturePath && c.stampPath).length },
    completedSteps: kvGetJson<string[]>("setup.completed_steps", []),
  });
});

export const PUT = route(async (req) => {
  const body = await parseBody(req, z.object({ settings: settingsSchema.optional(), completedStep: z.string().optional() }));
  if (body.settings) writeConfig("settings", body.settings);
  if (body.completedStep) {
    const steps = new Set(kvGetJson<string[]>("setup.completed_steps", []));
    steps.add(body.completedStep);
    kvSetJson("setup.completed_steps", [...steps]);
  }
  return ok({ settings: getSettings(), completedSteps: kvGetJson<string[]>("setup.completed_steps", []) });
});
