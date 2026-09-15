import { getEnv, getApproverPhone } from "@/lib/env";
import { kvGet, kvSet } from "@/database/repositories/kv";
import { logHistory } from "@/database/repositories/history";
import { nowIso } from "@/lib/ids";
import { getWhatsappClient, isWhatsappConfigured } from "./client";
import { textMessage, TEST_MESSAGE } from "./messages";
import { maskPhone } from "./approvals";

export { WhatsappClient, WhatsappError, getWhatsappClient, isWhatsappConfigured, setWhatsappClientForTests } from "./client";
export { verifySubscription, verifySignature, parseWebhook, parseButtonId } from "./webhook";
export { buildApprovalMessages, formatApprovalBody, textMessage, TEST_MESSAGE } from "./messages";
export { notifyPendingApproval, notifyUnsentApprovals, handleInboundEvent, maskPhone, MAX_NOTIFY_ATTEMPTS } from "./approvals";
export type { WhatsappInboundEvent } from "./types";

export interface WhatsappStatus {
  configured: boolean;
  tokenConfigured: boolean;
  phoneNumberIdConfigured: boolean;
  verifyTokenConfigured: boolean;
  appSecretConfigured: boolean;
  approverPhone: string | null; // masqué
  approverConfigured: boolean;
  lastTestAt: string | null;
  lastTestResult: string | null;
  webhookPath: string;
}

export function getWhatsappStatus(): WhatsappStatus {
  const env = getEnv();
  const approver = getApproverPhone();
  return {
    configured: isWhatsappConfigured(),
    tokenConfigured: Boolean(env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberIdConfigured: Boolean(env.WHATSAPP_PHONE_NUMBER_ID),
    verifyTokenConfigured: Boolean(env.WHATSAPP_VERIFY_TOKEN),
    appSecretConfigured: Boolean(env.WHATSAPP_APP_SECRET),
    approverPhone: approver ? `+${maskPhone(approver)}` : null,
    approverConfigured: Boolean(approver),
    lastTestAt: kvGet("whatsapp.last_test_at") || null,
    lastTestResult: kvGet("whatsapp.last_test_result") || null,
    webhookPath: "/api/integrations/whatsapp/webhook",
  };
}

/** Envoie un vrai message de test au numéro autorisé. */
export async function testWhatsappConnection(): Promise<{ ok: boolean; message: string }> {
  const status = getWhatsappStatus();
  if (!status.tokenConfigured || !status.phoneNumberIdConfigured) return { ok: false, message: "WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID non renseignés" };
  if (!status.verifyTokenConfigured) return { ok: false, message: "WHATSAPP_VERIFY_TOKEN non renseigné" };
  if (!status.approverConfigured) return { ok: false, message: "WHATSAPP_APPROVER_PHONE non renseigné" };
  const approver = getApproverPhone() as string;
  try {
    const r = await getWhatsappClient().send(textMessage(approver, TEST_MESSAGE));
    kvSet("whatsapp.last_test_at", nowIso());
    kvSet("whatsapp.last_test_result", "ok");
    logHistory({ eventType: "whatsapp.test", message: `Message de test WhatsApp envoyé (${status.approverPhone})`, actor: "user", details: { messageId: r.messageId } });
    return { ok: true, message: `Message de test envoyé à ${status.approverPhone}${status.appSecretConfigured ? "" : " — WHATSAPP_APP_SECRET absent : les webhooks ne seront pas vérifiés (refusés en production)"}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur WhatsApp";
    kvSet("whatsapp.last_test_at", nowIso());
    kvSet("whatsapp.last_test_result", `erreur : ${message}`);
    return { ok: false, message };
  }
}
