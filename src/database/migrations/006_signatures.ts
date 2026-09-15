export const name = "006_signatures";

/**
 * Phase 5 — Devis / signature graphique :
 * - documents : référence et validité de devis, objet, chaînage original → copie signée
 *   (parent_document_id, signed_document_id, action/approval de signature).
 */
export const sql = String.raw`
ALTER TABLE documents ADD COLUMN quote_number TEXT;
ALTER TABLE documents ADD COLUMN valid_until TEXT;
ALTER TABLE documents ADD COLUMN subject TEXT;
ALTER TABLE documents ADD COLUMN parent_document_id TEXT;
ALTER TABLE documents ADD COLUMN signed_document_id TEXT;
ALTER TABLE documents ADD COLUMN signed_action_id TEXT;
ALTER TABLE documents ADD COLUMN signed_approval_id TEXT;
ALTER TABLE documents ADD COLUMN sent_at TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_document_id);
`;
