import Link from "next/link";
import { Card, Empty } from "@/components/ui";
import { getDb } from "@/database/connection";
import { listHistory } from "@/database/repositories/history";
import { getSettings } from "@/lib/config";
import { formatDateTime, formatTime } from "@/lib/time";

export const dynamic = "force-dynamic";

const ACTOR_LABEL: Record<string, string> = { ema: "EMA", user: "Vous", worker: "Worker", whatsapp: "WhatsApp", system: "Système" };

export default function HistoryPage() {
  const db = getDb();
  const tz = getSettings().company.timezone;
  const events = listHistory({ limit: 300 }, db);
  const byDay = new Map<string, typeof events>();
  for (const e of events) {
    const day = formatDateTime(e.at, tz).slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }

  return (
    <>
      <h1>Historique</h1>
      {events.length === 0 ? <Empty>Aucune action enregistrée pour le moment.</Empty> : null}
      {[...byDay.entries()].map(([day, list]) => (
        <Card key={day} title={day}>
          <ul className="timeline">
            {list.map((h) => (
              <li key={h.id}>
                <time>{formatTime(h.at, tz)}</time>
                <span>
                  <span className="badge" style={{ marginRight: "0.5rem" }}>{ACTOR_LABEL[h.actor] ?? h.actor}</span>
                  {h.message}
                  {h.email_id ? <> · <Link href={`/emails/${h.email_id}`} className="muted">email</Link></> : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}
