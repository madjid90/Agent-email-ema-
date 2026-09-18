import type { Db } from "../connection";
import { getDb } from "../connection";
import type { ChatChannel, ChatMessageRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewChatMessage {
  /** Propriétaire de la conversation : jamais mélangée entre utilisateurs. */
  userId?: string | null;
  role: ChatMessageRow["role"];
  content: string;
  toolCalls?: unknown;
  channel?: ChatChannel;
  /** Identifiant Meta du message WhatsApp (unique, dédoublonnage). */
  externalId?: string | null;
  /** Numéro masqué de l'expéditeur (jamais le numéro complet). */
  sender?: string | null;
  refs?: unknown;
  emailId?: string | null;
  documentId?: string | null;
  actionId?: string | null;
}

export function insertMessage(input: NewChatMessage, db: Db = getDb()): ChatMessageRow {
  const id = newId("msg");
  db.prepare(
    `INSERT INTO chat_messages (id, user_id, role, content, tool_calls, created_at, channel, external_id, sender, refs, email_id, document_id, action_id)
     VALUES (@id, @user_id, @role, @content, @tool_calls, @created_at, @channel, @external_id, @sender, @refs, @email_id, @document_id, @action_id)`,
  ).run({
    id,
    user_id: input.userId ?? null,
    role: input.role,
    content: input.content,
    tool_calls: input.toolCalls === undefined ? null : JSON.stringify(input.toolCalls),
    created_at: nowIso(),
    channel: input.channel ?? "WEB",
    external_id: input.externalId ?? null,
    sender: input.sender ?? null,
    refs: input.refs === undefined ? null : JSON.stringify(input.refs),
    email_id: input.emailId ?? null,
    document_id: input.documentId ?? null,
    action_id: input.actionId ?? null,
  });
  return db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow;
}

/** Compat phase 2 : message de l'interface web. */
export function insertChatMessage(role: ChatMessageRow["role"], content: string, toolCalls?: unknown, db: Db = getDb()): ChatMessageRow {
  return insertMessage({ role, content, toolCalls }, db);
}

/**
 * Historique d'un canal. `userId` fourni : uniquement la conversation de cet
 * utilisateur ; absent (instance mono-utilisateur, tests) : le canal entier.
 */
export function listChatMessages(limit = 50, db: Db = getDb(), channel: ChatChannel = "WEB", userId?: string | null): ChatMessageRow[] {
  const rows = (userId
    ? db.prepare("SELECT * FROM chat_messages WHERE channel = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?").all(channel, userId, limit)
    : db.prepare("SELECT * FROM chat_messages WHERE channel = ? ORDER BY created_at DESC LIMIT ?").all(channel, limit)) as ChatMessageRow[];
  return rows.reverse();
}

/** Dernier message de l'assistant portant des références numérotées (contexte multi-tours). */
export function lastMessageWithRefs(channel: ChatChannel, db: Db = getDb(), userId?: string | null): ChatMessageRow | null {
  const row = userId
    ? db.prepare("SELECT * FROM chat_messages WHERE channel = ? AND user_id = ? AND role = 'assistant' AND refs IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(channel, userId)
    : db.prepare("SELECT * FROM chat_messages WHERE channel = ? AND role = 'assistant' AND refs IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(channel);
  return (row as ChatMessageRow | undefined) ?? null;
}

export function getMessageByExternalId(externalId: string, db: Db = getDb()): ChatMessageRow | null {
  return (db.prepare("SELECT * FROM chat_messages WHERE external_id = ?").get(externalId) as ChatMessageRow | undefined) ?? null;
}

export function clearChat(db: Db = getDb(), channel?: ChatChannel, userId?: string | null): void {
  if (userId && channel) db.prepare("DELETE FROM chat_messages WHERE channel = ? AND user_id = ?").run(channel, userId);
  else if (userId) db.prepare("DELETE FROM chat_messages WHERE user_id = ?").run(userId);
  else if (channel) db.prepare("DELETE FROM chat_messages WHERE channel = ?").run(channel);
  else db.prepare("DELETE FROM chat_messages").run();
}
