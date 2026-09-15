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
| `get_email` | `{ email_id }` | `Email` | LOW | Lecture |
| `get_email_thread` | `{ email_id }` ou `{ thread_id }` | `Email[]` (ordre chronologique) | LOW | Lecture |
| `search_emails` | `{ query, from?, subject?, since?, max? }` | `EmailSummary[]` | LOW | Lecture |
| `get_attachment` | `{ email_id, attachment_id }` | `{ document_id, name, mime, size, text_preview? }` | LOW | Télécharge dans `private/documents/` |
| `reply_email` | `{ email_id, body, reply_all?, attachments?: document_id[] }` | `{ action_id }` | MEDIUM | Crée une action `reply_email` |
| `forward_email` | `{ email_id, to: string[], comment? }` | `{ action_id }` | MEDIUM | Crée une action `forward_email` |
| `send_email` | `{ to: string[], subject, body, attachments? }` | `{ action_id }` | MEDIUM | Crée une action `send_email` |

## Documents (`src/tools/documents`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `extract_pdf_text` | `{ document_id, max_chars? }` | `{ text, pages }` | LOW |
| `classify_document` | `{ document_id }` | `{ type: invoice/quote/contract/other, confidence }` | LOW |
| `extract_invoice_data` | `{ document_id }` | `InvoiceData` (supplier, invoiceNumber, amountHT/TTC, dueDate, site, subject) | LOW |
| `extract_quote_data` | `{ document_id }` | `QuoteData` (supplier, company, amount, date, reference, subject) | LOW |
| `archive_document` | `{ document_id, category, company_id? }` | `{ path }` | LOW |

## Paiements (`src/tools/payments`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `prepare_payment_request` | `{ email_id, supplier, amount?, due_date?, subject, to? }` | `{ action_id, draft }` | HIGH |
| `prepare_deposit_request` | `{ email_id, supplier, project, amount?, to? }` | `{ action_id, draft }` | HIGH |

Ces tools ne paient jamais : ils préparent un email interne et créent une action en attente de validation.

## Relances (`src/tools/followups`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `schedule_followup` | `{ email_id, thread_id, execute_at, reason }` | `{ followup_id }` | LOW |
| `cancel_followup` | `{ followup_id, reason? }` | `{ ok }` | LOW |
| `check_reply_received` | `{ thread_id, since }` | `{ replied: boolean, reply_email_id? }` | LOW |

## Validations (`src/tools/approvals`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `request_approval` | `{ action_id, summary, proposed_reply? }` | `{ approval_id }` | LOW (envoi WhatsApp) |
| `get_approval_status` | `{ approval_id }` | `{ status, decided_at?, comment? }` | LOW |

## Signatures (`src/tools/signatures`)

| Tool | Entrée | Sortie | Risque |
|---|---|---|---|
| `prepare_signed_document` | `{ document_id, company_id, email_id }` | `{ action_id }` | CRITICAL |
| `apply_signature` | `{ document_id, company_id, page?, position? }` | `{ signed_document_id }` | CRITICAL (interne, appelé par l'exécuteur) |
| `apply_stamp` | `{ document_id, company_id, page?, position? }` | `{ signed_document_id }` | CRITICAL (interne) |

`apply_signature` et `apply_stamp` ne sont **pas exposés à Claude** : seul `prepare_signed_document` l'est. L'exécuteur `sign_document` les appelle après validation.

## Modes d'exposition

| Mode | Tools exposés à Claude |
|---|---|
| `analyze` (worker) | lecture Outlook, documents, `schedule_followup`, création d'actions (reply/forward/payment/signature) |
| `chat` (Chat EMA) | tout `analyze` + `search_emails`, `get_approval_status`, `cancel_followup` |
| `followup` (worker) | `get_email_thread`, `check_reply_received`, `reply_email`, `cancel_followup` |

## Contrat d'erreur

Un tool renvoie `{ ok: false, error: { code, message } }` à Claude en cas d'échec (jamais de stack, jamais de secret). Le registre journalise l'erreur.
