import { EmaError } from "@/lib/errors";
import type { Settings } from "@/lib/config";

/**
 * Calcul des échéances de relance — entièrement côté serveur (CLAUDE.md §7).
 * Le modèle n'exprime qu'une INTENTION temporelle (« dans 3 jours », « vendredi »,
 * « le 22 septembre ») ; la date finale est calculée ici, dans le fuseau du
 * client, avec l'heure par défaut configurée. Aucun horodatage produit par
 * Claude n'est utilisé tel quel.
 */
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface FollowupWhen {
  /** Nombre de jours à partir d'aujourd'hui (« dans 3 jours », « demain » = 1). */
  in_days?: number | null;
  /** Date explicite au format AAAA-MM-JJ (« le 22 septembre »). */
  date?: string | null;
  /** Prochain jour de la semaine (« vendredi »). */
  weekday?: Weekday | null;
  /** Heure locale HH:MM ; sinon `settings.followups.defaultTime`. */
  time?: string | null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Décalage du fuseau (ms) à un instant donné. */
function offsetMs(date: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year as number, (parts.month as number) - 1, parts.day as number, (parts.hour as number) % 24, parts.minute as number, parts.second as number);
  return asUtc - date.getTime();
}

/** Date/heure locale d'un fuseau → instant ISO UTC (deux passes pour les changements d'heure). */
export function zonedToIso(year: number, month: number, day: number, hour: number, minute: number, timezone: string): string {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let instant = new Date(guess - offsetMs(new Date(guess), timezone));
  instant = new Date(guess - offsetMs(instant, timezone));
  return instant.toISOString();
}

/** Composantes locales (année, mois, jour, jour de semaine) d'un instant. */
export function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") parts[p.type] = p.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Sun");
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: weekday < 0 ? 0 : weekday };
}

function addLocalDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Intention → instant ISO. Priorité : date explicite, puis jour de la semaine,
 * puis nombre de jours, puis délai par défaut. La date obtenue est toujours
 * dans le futur ; `businessDaysOnly` décale samedi/dimanche au lundi.
 */
export function resolveFollowupDate(when: FollowupWhen | null | undefined, settings: Settings, now: Date = new Date()): string {
  const cfg = settings.followups;
  const tz = settings.company.timezone;
  const time = when?.time ?? cfg.defaultTime;
  const t = TIME_RE.exec(time);
  if (!t) throw new EmaError("VALIDATION", `Heure invalide : ${time} (attendu HH:MM)`);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const today = zonedParts(now, tz);

  let target: { year: number; month: number; day: number };
  const explicitDate = Boolean(when?.date);
  if (when?.date) {
    const m = DATE_RE.exec(when.date);
    if (!m) throw new EmaError("VALIDATION", `Date invalide : ${when.date} (attendu AAAA-MM-JJ)`);
    target = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  } else if (when?.weekday) {
    const wanted = WEEKDAYS.indexOf(when.weekday);
    if (wanted < 0) throw new EmaError("VALIDATION", `Jour invalide : ${when.weekday}`);
    let delta = (wanted - today.weekday + 7) % 7;
    if (delta === 0) delta = 7; // « vendredi » un vendredi = le vendredi suivant
    target = addLocalDays(today.year, today.month, today.day, delta);
  } else {
    const days = when?.in_days ?? cfg.defaultDelayDays;
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new EmaError("VALIDATION", `Délai invalide : ${String(days)} jour(s)`);
    target = addLocalDays(today.year, today.month, today.day, days);
  }

  if (cfg.businessDaysOnly) {
    let guard = 0;
    while (guard++ < 7) {
      const wd = weekdayOf(target.year, target.month, target.day);
      if (wd !== 0 && wd !== 6) break;
      target = addLocalDays(target.year, target.month, target.day, 1);
    }
  }

  let iso = zonedToIso(target.year, target.month, target.day, hour, minute, tz);
  // Échéance déjà passée (ex. « aujourd'hui 09:00 » demandé à 14:00) → jour suivant ouvré.
  if (!explicitDate) {
    let guard = 0;
    while (iso <= now.toISOString() && guard++ < 10) {
      target = addLocalDays(target.year, target.month, target.day, 1);
      if (cfg.businessDaysOnly) {
        const wd = weekdayOf(target.year, target.month, target.day);
        if (wd === 0 || wd === 6) continue;
      }
      iso = zonedToIso(target.year, target.month, target.day, hour, minute, tz);
    }
  }
  return iso;
}

/** Bornes locales de la journée (compteurs, page Relances). */
export function dayBounds(timezone: string, now: Date = new Date()): { start: string; end: string } {
  const p = zonedParts(now, timezone);
  const next = addLocalDays(p.year, p.month, p.day, 1);
  return { start: zonedToIso(p.year, p.month, p.day, 0, 0, timezone), end: zonedToIso(next.year, next.month, next.day, 0, 0, timezone) };
}
