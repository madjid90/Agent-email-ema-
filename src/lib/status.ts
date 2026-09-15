import { getDb } from "@/database/connection";
import { kvGet } from "@/database/repositories/kv";
import { getConfiguredIntegrations } from "./env";
import { testAnthropicConnection } from "@/integrations/anthropic/client";
import { getOutlookStatus, testOutlookConnection } from "@/integrations/microsoft";
import { getWhatsappStatus, testWhatsappConnection } from "@/integrations/whatsapp";
import { privateRoot, PRIVATE_DIRS } from "./paths";
import fs from "node:fs";
import path from "node:path";

export type ComponentName = "claude" | "outlook" | "whatsapp" | "sqlite" | "pdf" | "worker";

export interface ComponentStatus {
  component: ComponentName;
  ok: boolean;
  configured: boolean;
  message: string;
}

export async function testComponent(name: ComponentName): Promise<ComponentStatus> {
  const cfg = getConfiguredIntegrations();
  switch (name) {
    case "claude": {
      if (!cfg.anthropic) return { component: name, ok: false, configured: false, message: "ANTHROPIC_API_KEY non renseignée" };
      const r = await testAnthropicConnection();
      return { component: name, ok: r.ok, configured: true, message: `${r.message} (${r.model})` };
    }
    case "outlook": {
      const s = getOutlookStatus();
      const r = await testOutlookConnection();
      return { component: name, ok: r.ok, configured: s.configured, message: r.message };
    }
    case "whatsapp": {
      const s = getWhatsappStatus();
      if (!s.configured) return { component: name, ok: false, configured: false, message: "WhatsApp non configuré (token, numéro, verify token, numéro autorisé)" };
      const r = await testWhatsappConnection();
      return { component: name, ok: r.ok, configured: true, message: r.message };
    }
    case "sqlite": {
      try {
        const row = getDb().prepare("SELECT sqlite_version() AS v").get() as { v: string };
        return { component: name, ok: true, configured: true, message: `SQLite ${row.v}, migrations appliquées` };
      } catch (err) {
        return { component: name, ok: false, configured: true, message: err instanceof Error ? err.message : "Erreur SQLite" };
      }
    }
    case "pdf": {
      const missing = PRIVATE_DIRS.filter((d) => !fs.existsSync(path.join(privateRoot(), d)));
      if (missing.length) return { component: name, ok: false, configured: false, message: `Dossiers manquants : ${missing.join(", ")}` };
      return { component: name, ok: true, configured: true, message: "Stockage privé prêt (extraction/signature PDF : phases 4-5)" };
    }
    case "worker": {
      const hb = kvGet("worker.heartbeat_at");
      if (!hb) return { component: name, ok: false, configured: true, message: "Aucun signal du worker (lancer `npm run worker` ou pm2)" };
      const ageSec = (Date.now() - new Date(hb).getTime()) / 1000;
      const ok = ageSec < 120;
      return { component: name, ok, configured: true, message: ok ? `Worker actif (dernier signal il y a ${Math.round(ageSec)} s)` : `Worker inactif depuis ${Math.round(ageSec / 60)} min` };
    }
  }
}

export async function testAllComponents(): Promise<ComponentStatus[]> {
  const names: ComponentName[] = ["sqlite", "pdf", "worker", "claude", "outlook", "whatsapp"];
  return Promise.all(names.map((n) => testComponent(n)));
}
