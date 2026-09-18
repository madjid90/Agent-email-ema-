/**
 * Normalisation des numéros de téléphone au format international E.164
 * (« +33612345678 »). Un numéro est l'identité WhatsApp d'un utilisateur EMA :
 * il doit être comparé sous une forme unique, quelle que soit la saisie
 * (« 06 12 34 56 78 », « +33 6 12 34 56 78 », « 0033612345678 », « 33612345678 »).
 */
export const DEFAULT_COUNTRY_CODE = "33";

/** Renvoie le numéro en E.164, ou null si la saisie n'est pas un numéro plausible. */
export function normalizePhone(input: string | null | undefined, defaultCountryCode: string = DEFAULT_COUNTRY_CODE): string | null {
  if (!input) return null;
  let raw = input.trim().replace(/[\s.\-()]/g, "");
  if (!raw) return null;
  if (raw.startsWith("00")) raw = `+${raw.slice(2)}`;
  let digits: string;
  if (raw.startsWith("+")) {
    digits = raw.slice(1);
  } else if (raw.startsWith("0") && raw.length >= 9 && raw.length <= 10) {
    // Numéro national (France par défaut) : 06 12 34 56 78 → +33 6 12 34 56 78
    digits = `${defaultCountryCode}${raw.slice(1)}`;
  } else {
    // WhatsApp transmet l'expéditeur en chiffres sans « + » : 33612345678
    digits = raw;
  }
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Forme attendue par l'API WhatsApp Cloud : chiffres sans « + ». */
export function toWhatsappId(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** Affichage masqué : seuls les trois derniers chiffres restent lisibles. */
export function maskE164(e164: string | null | undefined): string {
  if (!e164) return "—";
  const digits = e164.replace(/^\+/, "");
  return `+${digits.slice(0, 2)}${"•".repeat(Math.max(0, digits.length - 5))}${digits.slice(-3)}`;
}

/** Affichage lisible : +33 6 12 34 56 78. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const digits = e164.replace(/^\+/, "");
  if (digits.startsWith("33") && digits.length === 11) {
    const local = digits.slice(2);
    return `+33 ${local.slice(0, 1)} ${local.slice(1, 3)} ${local.slice(3, 5)} ${local.slice(5, 7)} ${local.slice(7, 9)}`;
  }
  return `+${digits}`;
}
