import type { Db } from "../connection";
import { getDb } from "../connection";
import type { ChatMessageRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

export function insertChatMessage(role: ChatMessageRow["role"], content: string, toolCalls?: unknown, db: Db = getDb()): ChatMessageRow {
  const id = newId("msg");
  db.prepare("INSERT INTO chat_messages (id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    role,
    content,
    toolCalls === undefined ? null : JSON.stringify(toolCalls),
    nowIso(),
  );
  return db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow;
}

export function listChatMessages(limit = 50, db: Db = getDb()): ChatMessageRow[] {
  const rows = db.prepare("SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?").all(limit) as ChatMessageRow[];
  return rows.reverse();
}

export function clearChat(db: Db = getDb()): void {
  db.prepare("DELETE FROM chat_messages").run();
}
