import { z } from "zod";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as chatRepo from "@/database/repositories/chat";
import type { ChatChannel } from "@/database/types";
import type { ToolResult } from "@/tools";

/**
 * Références conversationnelles : la liste numérotée qu'EMA vient de présenter
 * (« 1. devis ABC — 4 850 € »). Elle est enregistrée avec le message de
 * l'assistant et réinjectée au tour suivant pour comprendre « le premier »,
 * « le deuxième » ou « réponds-lui ». Aucune nouvelle base : colonne `refs`
 * de chat_messages.
 */
export const conversationRefSchema = z.object({
  index: z.number().int().min(1),
  kind: z.enum(["email", "document", "action", "contact"]),
  id: z.string().min(1),
  label: z.string(),
  /** Décision en attente de désambiguïsation (« valide » avec plusieurs actions). */
  pendingDecision: z.enum(["approve", "reject"]).nullable().default(null),
});
export type ConversationRef = z.infer<typeof conversationRefSchema>;

const MAX_REFS = 8;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function emailLabel(row: Row): string {
  const from = str(row, "from") ?? ((row.from as Row | undefined)?.name as string | undefined) ?? ((row.from as Row | undefined)?.email as string | undefined) ?? null;
  return [from, str(row, "subject")].filter(Boolean).join(" — ") || "email";
}

function documentLabel(row: Row): string {
  const parts = [str(row, "supplier_name") ?? str(row, "supplier"), str(row, "quote_number") ?? str(row, "invoice_number"), str(row, "name")].filter(Boolean);
  return parts.join(" — ") || "document";
}

/** Extrait les références d'un résultat de tool (listes ou objet unique). */
export function refsFromToolResult(tool: string, result: ToolResult<unknown>): Omit<ConversationRef, "index">[] {
  if (!result.ok) return [];
  const rows: Row[] = Array.isArray(result.data) ? (result.data as Row[]) : [result.data as Row];
  const out: Omit<ConversationRef, "index">[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const emailId = str(row, "email_id");
    const documentId = str(row, "document_id");
    const actionId = str(row, "action_id");
    const contactEmail = str(row, "email");
    if (actionId) out.push({ kind: "action", id: actionId, label: str(row, "title") ?? str(row, "type") ?? "action", pendingDecision: null });
    else if (documentId) out.push({ kind: "document", id: documentId, label: documentLabel(row), pendingDecision: null });
    else if (emailId) out.push({ kind: "email", id: emailId, label: emailLabel(row), pendingDecision: null });
    else if (str(row, "contact_id") && contactEmail) out.push({ kind: "contact", id: contactEmail, label: `${str(row, "name") ?? contactEmail} <${contactEmail}>`, pendingDecision: null });
  }
  return out;
}

export function numberRefs(refs: Omit<ConversationRef, "index">[]): ConversationRef[] {
  const seen = new Set<string>();
  const unique: Omit<ConversationRef, "index">[] = [];
  for (const r of refs) {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  return unique.slice(0, MAX_REFS).map((r, i) => ({ ...r, index: i + 1 }));
}

export function readRefs(json: string | null): ConversationRef[] {
  if (!json) return [];
  try {
    const parsed = z.array(conversationRefSchema).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Dernières références présentées sur ce canal (contexte multi-tours). */
export function lastRefs(channel: ChatChannel, db: Db = getDb()): ConversationRef[] {
  return readRefs(chatRepo.lastMessageWithRefs(channel, db)?.refs ?? null);
}

/** Bloc de contexte injecté dans le prompt : identifiants explicites, jamais de contenu sensible. */
export function describeRefs(refs: ConversationRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((r) => `${r.index}. ${r.kind} ${r.id} — ${r.label}`);
  return `Références de ta dernière réponse (« le premier » = 1, « le deuxième » = 2, « lui » = l'interlocuteur concerné) :\n${lines.join("\n")}`;
}

const ORDINALS: Record<string, number> = {
  "1": 1, "1er": 1, premier: 1, première: 1, premiere: 1,
  "2": 2, "2e": 2, "2eme": 2, deuxieme: 2, deuxième: 2, second: 2, seconde: 2,
  "3": 3, "3e": 3, "3eme": 3, troisieme: 3, troisième: 3,
  "4": 4, quatrieme: 4, quatrième: 4,
};

/** Résolution déterministe d'un ordinal isolé (« le deuxième », « 2 ») → index. */
export function parseOrdinal(text: string): number | null {
  const clean = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(le|la|les|l|celui|celle|numero|no|n|action|devis|email|mail|document)\b/g, " ")
    .trim();
  if (!clean || clean.split(/\s+/).length > 2) return null;
  for (const word of clean.split(/\s+/)) {
    const n = ORDINALS[word];
    if (n) return n;
  }
  return null;
}
