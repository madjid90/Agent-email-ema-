/**
 * Registre des migrations, dans l'ordre d'application.
 * Les migrations sont embarquées en TypeScript pour rester disponibles
 * dans le bundle Next.js comme dans le worker (tsx).
 */
import * as m001 from "./001_init";
import * as m002 from "./002_outlook";
import * as m003 from "./003_analysis";
import * as m004 from "./004_whatsapp";
import * as m005 from "./005_documents";
import * as m006 from "./006_signatures";
import * as m007 from "./007_whatsapp_chat";
import * as m008 from "./008_followups";
import * as m009 from "./009_hardening";
import * as m010 from "./010_users";

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010].map((m) => ({ name: m.name, sql: m.sql }));
