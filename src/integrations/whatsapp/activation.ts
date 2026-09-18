import type { UserRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { formatPhone, normalizePhone, toWhatsappId } from "@/lib/phone";
import { isWhatsappConfigured } from "./client";

/** Message prérempli du premier contact : il déclenche l'association définitive du numéro. */
export const ACTIVATION_TEXT = "Bonjour EMA";

export interface WhatsappActivation {
  /** WhatsApp Business EMA configuré côté serveur (token, numéro, webhook). */
  configured: boolean;
  /** Numéro EMA affiché à l'utilisateur (E.164), s'il est renseigné. */
  businessNumber: string | null;
  businessNumberDisplay: string | null;
  /** Lien wa.me ouvrant la conversation avec le message d'activation. */
  openLink: string | null;
  status: "not_registered" | "pending" | "active" | "disabled";
  phoneNumber: string | null;
  phoneDisplay: string | null;
  verifiedAt: string | null;
  activationText: string;
}

/** État d'activation WhatsApp d'un utilisateur, pour Paramètres → Connexions. */
export function getWhatsappActivation(user: UserRow): WhatsappActivation {
  const business = normalizePhone(getEnv().WHATSAPP_BUSINESS_NUMBER);
  const status: WhatsappActivation["status"] = !user.phone_number ? "not_registered" : user.phone_verified !== 1 ? "pending" : user.whatsapp_enabled === 1 ? "active" : "disabled";
  return {
    configured: isWhatsappConfigured(),
    businessNumber: business,
    businessNumberDisplay: business ? formatPhone(business) : null,
    openLink: business ? `https://wa.me/${toWhatsappId(business)}?text=${encodeURIComponent(ACTIVATION_TEXT)}` : null,
    status,
    phoneNumber: user.phone_number,
    phoneDisplay: user.phone_number ? formatPhone(user.phone_number) : null,
    verifiedAt: user.verified_at,
    activationText: ACTIVATION_TEXT,
  };
}
