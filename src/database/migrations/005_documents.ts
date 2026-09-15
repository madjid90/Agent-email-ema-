export const name = "005_documents";

/**
 * Phase 4 — Document Engine : type documentaire, extraction de texte, données
 * facture dénormalisées (recherche, doublons, interface), vérification humaine.
 * Le JSON complet de l'analyse reste dans `extracted_data`.
 */
export const sql = String.raw`
ALTER TABLE documents ADD COLUMN doc_type TEXT;
ALTER TABLE documents ADD COLUMN text_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN text_pages INTEGER;
ALTER TABLE documents ADD COLUMN supplier_name TEXT;
ALTER TABLE documents ADD COLUMN invoice_number TEXT;
ALTER TABLE documents ADD COLUMN invoice_date TEXT;
ALTER TABLE documents ADD COLUMN due_date TEXT;
ALTER TABLE documents ADD COLUMN amount_excl_tax REAL;
ALTER TABLE documents ADD COLUMN amount_incl_tax REAL;
ALTER TABLE documents ADD COLUMN currency TEXT;
ALTER TABLE documents ADD COLUMN doc_confidence REAL;
ALTER TABLE documents ADD COLUMN requires_human_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN possible_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN duplicate_of TEXT NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN bank_details_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN analyzed_at TEXT;
ALTER TABLE documents ADD COLUMN analysis_error TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_invoice ON documents(supplier_name, invoice_number);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
`;
