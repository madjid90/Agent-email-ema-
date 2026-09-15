export const name = "007_whatsapp_chat";

/**
 * Phase 6 — Pilotage depuis WhatsApp :
 * - chat_messages devient multi-canal (WEB / WHATSAPP) et garde les références
 *   structurées présentées à l'utilisateur (emails, documents, actions) pour
 *   comprendre « le premier », « le deuxième », « réponds-lui ».
 * - Aucune nouvelle base mémoire : la conversation WhatsApp réutilise chat_messages.
 */
export const sql = String.raw`
ALTER TABLE chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'WEB';
ALTER TABLE chat_messages ADD COLUMN external_id TEXT;
ALTER TABLE chat_messages ADD COLUMN sender TEXT;
ALTER TABLE chat_messages ADD COLUMN refs TEXT;
ALTER TABLE chat_messages ADD COLUMN email_id TEXT;
ALTER TABLE chat_messages ADD COLUMN document_id TEXT;
ALTER TABLE chat_messages ADD COLUMN action_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_external ON chat_messages(external_id) WHERE external_id IS NOT NULL;
`;
