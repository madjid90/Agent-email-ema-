/**
 * Registre des migrations, dans l'ordre d'application.
 * Les migrations sont embarquées en TypeScript pour rester disponibles
 * dans le bundle Next.js comme dans le worker (tsx).
 */
import * as m001 from "./001_init";
import * as m002 from "./002_outlook";
import * as m003 from "./003_analysis";

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [m001, m002, m003].map((m) => ({ name: m.name, sql: m.sql }));
