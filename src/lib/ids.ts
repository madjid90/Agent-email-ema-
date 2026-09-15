import { randomUUID } from "node:crypto";

/** Identifiant préfixé lisible : act_…, apr_…, doc_…, fup_…, eml_… */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
