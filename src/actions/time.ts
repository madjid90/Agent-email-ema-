export { nowIso } from "@/lib/ids";
import { addHours } from "@/lib/time";

export function addHoursSafe(iso: string, hours: number): string {
  return addHours(iso, Number.isFinite(hours) && hours > 0 ? hours : 48);
}
