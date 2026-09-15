# TOOLS.md — Couche de tools d'EMA

Tous les tools sont définis avec `defineTool()` (`src/tools/types.ts`) :

```ts
defineTool({
  name: "get_email",
  description: "...",
  riskLevel: "LOW",
  input: z.object({ email_id: z.string() }),
  output: EmailSchema,
  handler: async (input, ctx) => { ... },
});
```

- `input` et `output` sont des schémas **zod** ; l'entrée est validée avant exécution, la sortie avant retour à Claude.
- Claude reçoit uniquement `name`, `description` et le JSON Schema d'entrée (`src/tools/registry.ts`).
- `ctx` (`ToolContext`) donne accès aux repositories, à la config et au journal ; **jamais** aux secrets. Les intégrations (`src/integrations/*`) lisent l'env elles-mêmes.
- `riskLevel` sert à l'Action Engine : un tool `HIGH`/`CRITICAL` ne s'exécute jamais directement depuis Claude ; il **crée une action** en attente de validation.
- Chaque tool à effet de bord écrit dans `history`.

## Outlook (`src/tools/outlook`)

| Tool | Entrée | Sortie | Risque | Effet |
|---|---|---|---|---|
| `get_new_emails` | `{ since?: ISO, max?: number }` | `Email[]` | LOW | Lecture |
| `get_email` | `{ email_id }` | `Email` + liste des pièces jointes (`attachment_id`, `document_id` si déjà archivée) | LOW | Lecture (Graph si pièces jointes non archivées) |
| `get_email_thread` | `{ email_id }` ou `{ thread_id }` | `Email[]` (ordre chronologique, 20 max) | LOW | Graph `conversationId`, messages inconnus importés en `CONTEXT` |
| `search_emails` | `{ query, from?, since?, max? }` | `EmailSummary[]` | LOW | Graph `$search` (KQL), 50 max |
| `get_attachment` | `{ email_id, attachment_id }` | `{ document_id, name, mime, size, text_preview }` | LOW | Télécharge dans `private/documents/yyyy/mm/` (refus types dangereux / trop gros) |
| `reply_email` | `{ email_id, body, reply_all?, attachments?: document_id[] }` | `{ action_id }` | MEDIUM | Crée une action `reply_email` |
| `forward_email` | `{ email_id, to: string[], comment? }` | `{ action_id }` | MEDIUM | Crée une action `forward_email` |
| `send_email` | `{ to: string[], subject, body, attachments? }` | `{ action_id }` | MEDIUM | Crée une action `send_email` |

## Documents (`src/tools/documents`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `extract_pdf_text` | `{ document_id, max_chars? }` | `{ text, pages, truncated, status }` — extraction pdf-parse, une seule fois | LOW |
| `classify_document` | `{ document_id }` | `{ type: INVOICE/CREDIT_NOTE/QUOTE/PAYMENT_PROOF/BANK_DETAILS/PURCHASE_ORDER/CONTRACT/OTHER/UNKNOWN, confidence, source }` | LOW |
| `extract_invoice_data` | `{ document_id }` | données facture (fournisseur, numéro, montants HT/TVA/TTC, échéance, société, avertissements, doublons) — lance l'analyse si nécessaire | LOW |
| `extract_quote_data` | `{ document_id }` | données devis (référence, validité, objet, montants, acompte, conditions) + `signature_requested` | LOW |
| `archive_document` | `{ document_id, category, company_id? }` | `{ document_id, category }` | LOW |
| `search_documents` | `{ query?, supplier?, invoice_number?, document_type?, since?, requires_review?, possible_duplicate?, max? }` | documents archivés | LOW |
| `get_document` | `{ document_id }` | détail + données extraites | LOW |
| `list_pending_actions` | `{ max? }` | actions en attente de validation | LOW |
| `prepare_document_forward` | `{ document_id, comment? }` | `{ action_id, to, rule_id }` — destinataire issu de `config/rules.json` puis des contacts internes, jamais choisi par le modèle | MEDIUM |

## Paiements (`src/tools/payments`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `prepare_payment_request` | `{ email_id, supplier, amount?, due_date?, subject, to? }` | `{ action_id, draft }` | HIGH |
| `prepare_deposit_request` | `{ email_id, supplier, project, amount?, to? }` | `{ action_id, draft }` | HIGH |

Ces tools ne paient jamais : ils préparent un email interne et créent une action en attente de validation.

## Relances (`src/tools/followups`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `schedule_followup` | `{ email_id?, reason, when: { in_days? \| date? \| weekday?, time? }, kind?, title?, document_id?, company_id? }` | `{ followup_id, execute_at }` — la date finale est **calculée côté serveur** | LOW |
| `list_followups` | `{ scope: today \| upcoming \| pending_approval \| needs_attention \| all, kind?, max? }` | relances et rappels | LOW |
| `postpone_followup` | `{ followup_id, when }` | nouvelle échéance (aucun doublon) | LOW |
| `cancel_followup` | `{ followup_id, reason? }` | `{ followup_id, status }` | LOW |
| `complete_reminder` | `{ followup_id }` | rappel interne marqué traité | LOW |
| `prepare_followup_now` | `{ followup_id }` | vérifie Outlook puis prépare la relance (action à valider) ; n'envoie jamais | MEDIUM |
| `check_reply_received` | `{ thread_id, since }` | `{ replied: boolean, reply_email_id? }` | LOW |

## Contacts et sociétés (`src/tools/contacts`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `search_contacts` | `{ query, internal_only?, max? }` | candidats issus de `config/contacts.json` puis des expéditeurs déjà reçus (0, 1 ou plusieurs) — aucune adresse inventée | LOW |
| `get_company` | `{ company_id?, query? }` | sociétés configurées, signataire, `signature_available` / `stamp_available` — **jamais** de chemin ni d'image | LOW |

## Validations (`src/tools/approvals`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `request_approval` | `{ action_id, summary, proposed_reply? }` | `{ approval_id }` | LOW (envoi WhatsApp) |
| `get_approval_status` | `{ approval_id }` | `{ status, decided_at?, comment? }` | LOW |
| `update_draft` | `{ action_id, body, subject? }` | brouillon modifié — texte et objet uniquement : destinataires, niveau de risque et statut restent inchangés | LOW |

## Signatures (`src/tools/signatures`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `prepare_signed_document` | `{ document_id, company_id }` | `{ prepared, action_id?, status?, risk_level?, requires_approval, reasons[], warnings[] }` | CRITICAL |

C'est le **seul** tool de signature. Il vérifie les prérequis (`checkSignatureReadiness`) et crée l'action `sign_document` en `WAITING_APPROVAL` — rien d'autre. Il n'existe **aucun** tool `apply_signature` / `apply_stamp` : l'application de la signature et du tampon (`createSignedCopy`, `buildSignedPdf` dans `src/documents/`) est une fonction interne appelée uniquement par l'exécuteur `sign_document` après validation humaine. Claude ne reçoit que `company_id` et des libellés logiques (« Signature Prénom Nom », « Tampon Société »), jamais un chemin, une image ni un base64. Détails : `docs/signatures.md`.

## Analyses (`src/tools/analysis`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `get_email_analysis` | `{ email_id }` | analyse EMA (catégorie, urgence, résumé, société, montant, action recommandée, brouillon) | LOW |
| `list_recent_emails` | `{ max?, category?, needs_reply?, since? }` | emails récents avec leur analyse | LOW |
| `get_today_summary` | `{ since? }` | compteurs du jour (urgents, à répondre, à valider, factures, devis à signer, demandes de paiement) et principaux éléments | LOW |

## Modes d'exposition

| Mode | Tools exposés à Claude |
|---|---|
| `analyze` (worker) | lecture Outlook, documents, `schedule_followup`, création d'actions (reply/forward/payment/signature) |
| `chat` (Chat EMA) | **lecture seule** — `get_email`, `get_email_thread`, `search_emails`, `get_email_analysis`, `list_recent_emails`, `get_approval_status`, `search_documents`, `get_document`, `list_pending_actions` — plus `prepare_signed_document`, qui ne fait que proposer une action CRITICAL à valider (liste `CHAT_READONLY_TOOLS`, `src/agent/chat.ts`). Aucune action bancaire n'existe ; les actions à effet passent par l'Action Engine et la validation. |
| `followup` (worker) | `get_email_thread`, `check_reply_received`, `reply_email`, `schedule_followup`, `list_followups`, `postpone_followup`, `cancel_followup`, `prepare_followup_now` |
| `whatsapp` (assistant WhatsApp) | liste explicite `WHATSAPP_TOOLS` (`src/agent/whatsapp-assistant.ts`), dérivée du mode `chat` : **lecture** (`get_email`, `get_email_thread`, `search_emails`, `get_email_analysis`, `list_recent_emails`, `search_documents`, `get_document`, `search_contacts`, `get_company`, `list_pending_actions`, `get_approval_status`, `get_today_summary`) et **préparation** (`reply_email`, `forward_email`, `send_email`, `prepare_document_forward`, `prepare_payment_request`, `prepare_deposit_request`, `prepare_signed_document`, `update_draft`). Chaque préparation crée une action soumise à validation ; aucune primitive d'envoi ou de signature n'est exposée. Détails : `docs/whatsapp-assistant.md`. |

## Contrat d'erreur

Un tool renvoie `{ ok: false, error: { code, message } }` à Claude en cas d'échec (jamais de stack, jamais de secret). Le registre journalise l'erreur.
