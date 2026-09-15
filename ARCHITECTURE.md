# ARCHITECTURE.md — Architecture d'EMA

## 1. Vue d'ensemble

```
┌──────────┐   Graph API    ┌──────────────────────────────────────────┐
│ OUTLOOK  │ ─────────────▶ │ EMA (VPS du client)                       │
│ (1 boîte)│ ◀───────────── │                                          │
└──────────┘  reply/forward │  Next.js (UI + routes API)               │
                            │  Worker (scan mailbox, relances)         │
┌──────────┐                │  Action Engine (SQLite)                  │
│ WHATSAPP │ ◀────────────▶ │  Tools typés                              │
│ (valid.) │  Cloud API     │  Claude (Anthropic API, tool calling)    │
└──────────┘                │  data/ema.db  private/  config/  .env    │
                            └──────────────────────────────────────────┘
```

Un client = un VPS = une instance = un `.env` = une base SQLite = un dossier `private/`.

## 2. Flux principal (scénario n°1)

1. **Worker** interroge Microsoft Graph toutes les `WORKER_POLL_INTERVAL` secondes : `get_new_emails()` (delta / filtre `receivedDateTime > last_scan`).
2. Chaque email inconnu est inséré dans `emails` (statut `NEW`). Les pièces jointes sont téléchargées dans `private/documents/`.
3. **Context builder** (`src/agent/context.ts`) assemble : email courant, thread (`get_email_thread`), historique pertinent (actions précédentes avec le même expéditeur / thread), règles applicables (`config/rules.json`), sociétés (`config/companies.json`), documents attachés (texte extrait).
4. **Orchestrator** (`src/agent/orchestrator.ts`) appelle Claude avec le prompt système `src/agent/ema.md`, le contexte dans un bloc `<untrusted_email_content>`, et les tools autorisés. Claude renvoie une **analyse structurée** (`EmailAnalysis` : category, urgency, summary, company, sender, requested_action, amount, due_date, recommended_action, confidence, requires_approval) validée par zod.
5. L'orchestrator transforme l'analyse en **actions** via l'Action Engine (`src/actions/engine.ts`) : `PROPOSED` → si `requires_approval` → `WAITING_APPROVAL` + `request_approval` (WhatsApp).
6. **Webhook WhatsApp** (`/api/whatsapp/webhook`) reçoit le clic bouton → `approvals.status = APPROVED/REJECTED` → l'engine passe l'action à `APPROVED` puis l'exécute (transition atomique `EXECUTING`) → `COMPLETED` ou `FAILED`.
7. Chaque étape écrit dans `history`.

## 3. Composants

### 3.1 Next.js (`src/app`)
- Pages : Aujourd'hui, Emails, À valider, Chat EMA, Documents, Relances, Historique, Règles, Sociétés, Paramètres, Setup.
- Routes API (`src/app/api/**`) : couche métier HTTP (setup, status, actions, approvals, followups, rules, companies, chat, webhooks).
- Server Components lisent SQLite via les repositories ; les mutations passent par les routes API.

### 3.2 Worker (`src/worker`)
Process Node autonome (PM2 `ema-worker`). Boucle simple :
- `scanMailbox()` : nouveaux emails → analyse.
- `processFollowups()` : relances échues → `check_reply_received` → annulation ou proposition de relance.
- `expireApprovals()` : validations expirées.
- `retryFailedActions()` : (phase ultérieure).
Chaque tâche est protégée par un verrou SQLite (`worker_locks`) pour éviter deux workers concurrents.

### 3.3 Agent (`src/agent`)
- `ema.md` : prompt système (rôle, catégories, ton, limites, quand demander validation).
- `prompts/` : templates (analyse, réponse, relance, chat).
- `context.ts` : construction du contexte borné (jamais toute la mailbox).
- `schemas.ts` : `EmailAnalysis` (zod) = sortie structurée obligatoire.
- `orchestrator.ts` : boucle tool calling avec Claude, garde-fous (max tours, tools autorisés par mode).

### 3.4 Tools (`src/tools`)
Définis par `defineTool()` : nom, description, `input` (zod), `output` (zod), `riskLevel`, `handler`. Le registre (`src/tools/registry.ts`) expose les définitions JSON Schema à Claude et exécute les appels après validation. Voir `TOOLS.md`.

### 3.5 Intégrations (`src/integrations`)
- `microsoft/` : OAuth (auth code + refresh), client Graph (fetch), stockage chiffré des tokens.
- `anthropic/` : client SDK, appel structuré, comptage d'usage.
- `whatsapp/` : envoi de messages interactifs, vérification webhook.
Seule cette couche lit les secrets.

### 3.6 Action Engine (`src/actions`)
Voir section 5.

### 3.7 Base SQLite (`src/database`)
Voir section 4.

### 3.8 Sécurité (`src/security`)
- `untrusted.ts` : encapsulation du contenu email/documents.
- `auth.ts` : session UI (cookie signé HMAC `APP_SECRET`, mot de passe `APP_PASSWORD`).
- `crypto.ts` : chiffrement AES-256-GCM des tokens OAuth avec une clé dérivée d'`APP_SECRET`.

## 4. SQLite

- Fichier : `DATABASE_PATH` (défaut `data/ema.db`), mode WAL, `foreign_keys = ON`.
- Accès : `better-sqlite3` synchrone, une connexion par process (singleton `getDb()`).
- Migrations : fichiers SQL numérotés dans `src/database/migrations/`, appliqués dans l'ordre et enregistrés dans `schema_migrations`. `npm run db:migrate` ou automatiquement au démarrage.
- Tables :

| Table | Rôle |
|---|---|
| `emails` | Emails traités (graph_id unique, thread, expéditeur, objet, statut, analyse JSON) |
| `email_analyses` | Résultat structuré de Claude par email (catégorie, urgence, montant, confiance…) |
| `actions` | Action Engine (type, statut, risque, payload, timestamps, erreur) |
| `approvals` | Demandes de validation (canal, message WhatsApp id, statut, réponse) |
| `scheduled_followups` | Relances programmées |
| `documents` | Pièces jointes archivées (original, version signée, type, société) |
| `history` | Journal de toutes les actions d'EMA |
| `oauth_tokens` | Tokens Microsoft chiffrés (jamais en clair) |
| `worker_locks` | Verrous d'exécution du worker |
| `settings_kv` | Paires clé/valeur runtime (dernier scan, état setup) |
| `chat_messages` | Historique du Chat EMA |

Les **règles**, **sociétés**, **contacts** et **paramètres** sont dans `config/*.json` (source de vérité éditable via l'UI et par le client en SSH). SQLite ne stocke que des données de fonctionnement.

## 5. Action Engine

```
PROPOSED ──(requires_approval)──▶ WAITING_APPROVAL ──▶ APPROVED ──▶ EXECUTING ──▶ COMPLETED
    │                                   │                                 └──▶ FAILED
    └──(LOW, auto)────────────▶ APPROVED                                  
                                        └──▶ REJECTED (refus ou expiration)
```

- `riskLevel` : `LOW` (préparer une réponse), `MEDIUM` (envoyer une réponse, transférer), `HIGH` (email lié à un paiement, relance engageante), `CRITICAL` (signature/tampon).
- `requires_approval = riskLevel ∈ {HIGH, CRITICAL} || règle "require_approval" || analyse.requires_approval || settings.autoReplyEnabled == false` pour un envoi.
- Exécution : `executeAction(id)` fait `UPDATE actions SET status='EXECUTING' WHERE id=? AND status='APPROVED'` ; si 0 ligne modifiée → déjà en cours/exécutée → abandon (idempotence).
- Les exécuteurs (`src/actions/executors/*`) sont enregistrés par `type` : `reply_email`, `forward_email`, `send_email`, `sign_document`, `payment_request`, `deposit_request`, `followup`.

## 6. Outlook (Microsoft Graph)

- App Azure AD (client id/secret, tenant). Redirect `MICROSOFT_REDIRECT_URI`.
- `/api/integrations/microsoft/connect` → URL d'autorisation ; `/callback` → échange du code, stockage chiffré ; `/status`, `/sync`, `/disconnect`.
- Appels Graph : `GET /me/mailFolders/inbox/messages/delta` (synchronisation incrémentale, curseur local), `GET /me/messages/{id}`, `GET /me/messages?$filter=conversationId eq '…'`, `GET /me/messages?$search=…`, `GET /me/messages/{id}/attachments`, `POST /me/messages/{id}/reply`, `POST /me/messages/{id}/forward`, `POST /me/sendMail`.
- Refresh token automatique avant expiration ; erreur 401 → `refresh` puis retry unique. Détails : `docs/outlook.md`.

## 7. WhatsApp

- Envoi : `POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages` type `interactive` (`reply` buttons `VALIDER`, `REFUSER`, `MODIFIER`).
- Réception : `GET /api/whatsapp/webhook` (vérification `hub.verify_token`), `POST` (événements `button_reply`).
- Le `button.id` = `approve:<approval_id>` / `reject:<approval_id>` / `edit:<approval_id>`.

## 8. Signatures / tampons

- `pdf-lib` copie le PDF original, ajoute sur la dernière page (position configurable par société) : « Bon pour accord », date, nom + fonction du signataire, image signature, image tampon.
- Claude ne voit que `company_id` ; la résolution des chemins se fait dans `src/tools/signatures/`.

## 9. Déploiement

Ubuntu VPS : Node 20+, PM2 (`ema-web`, `ema-worker`), Nginx reverse proxy, Certbot HTTPS. Voir `docs/deployment.md`.
