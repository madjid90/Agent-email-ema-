/** Formatage des dates pour l'UI (fuseau du client). */
export function formatDateTime(iso: string | null | undefined, timezone = "Europe/Paris", locale = "fr-FR"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatTime(iso: string | null | undefined, timezone = "Europe/Paris", locale = "fr-FR"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(d);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

/** Début du jour courant (UTC) en ISO — suffisant pour les compteurs "aujourd'hui". */
export function startOfTodayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function formatAmount(value: number | null | undefined, currency = "EUR", locale = "fr-FR"): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
}
