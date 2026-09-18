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
- `ema.md` : prompt système (rôle, catégories, ton, limites, quand demander validation). Stable, mis en cache.
- `prompts/` : templates (analyse, relance, chat).
- `context.ts` : Context Engine — contexte borné, données fiables séparées du contenu non fiable encapsulé (jamais toute la mailbox).
- `schemas.ts` : `EmailAnalysis` (zod) = sortie structurée obligatoire.
- `rules.ts` : moteur de règles déterministe (`config/rules.json`), destinataires de transfert.
- `orchestrator.ts` : `analyzeEmail()` (Claude en sortie structurée, garde-fous, règles, persistance, statuts) et `analyzePendingEmails()` (worker).
- `chat.ts` : Chat EMA, boucle tool calling bornée, outils de lecture uniquement en phase 2.
Détails : `docs/analysis.md`.

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
- `auth.ts` : session par compte (cookie signé HMAC `APP_SECRET` portant `user_id`), `getSessionUser()` / `requireSessionUser()` — seule source d'identité côté web.
- `accounts.ts` / `passwords.ts` : inscription (premier compte = `owner`, suivants si `ALLOW_SIGNUP=true`), connexion email + mot de passe (scrypt).
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
| `llm_runs` | Journal des appels Claude (modèle, tokens, durée, issue), sans contenu |
| `webhook_events` | Dédoublonnage des événements entrants (WhatsApp), identifiant Meta unique |

Les **règles**, **sociétés**, **contacts** et **paramètres** sont dans `config/*.json` (source de vérité éditable via l'UI et par le client en SSH). SQLite ne stocke que des données de fonctionnement.

## 5. Action Engine

```
PROPOSED ──(requires_approval)──▶ WAITING_APPROVAL ──▶ APPROVED ──▶ EXECUTING ──▶ COMPLETED
    │                                   │                                 └──▶ FAILED
    └──(LOW, auto)────────────▶ APPROVED                                  
                                        └──▶ REJECTED (refus ou expiration)
```

- `riskLevel` : `LOW` (préparer une réponse), `MEDIUM` (envoyer une réponse, transférer), `HIGH` (email lié à un paiement, relance engageante), `CRITICAL` (signature/tampon).
- `requires_approval = riskLevel ∈ {HIGH, CRITICAL} || règle "require_approval" || analyse.requires_approval || settings.autoReplyEnabled == false` pour un envoi. En phase 3, toute réponse email issue de l'analyse est explicitement soumise à validation.
- Expiration d'une demande : l'approval passe `EXPIRED`, l'action reste `WAITING_APPROVAL` (renvoi possible). `FAILED → APPROVED` uniquement par « Réessayer » explicite.
- Exécution : `executeAction(id)` fait `UPDATE actions SET status='EXECUTING' WHERE id=? AND status='APPROVED'` ; si 0 ligne modifiée → déjà en cours/exécutée → abandon (idempotence).
- Les exécuteurs (`src/actions/executors/*`) sont enregistrés par `type` : `reply_email`, `forward_email`, `send_email`, `sign_document`, `payment_request`, `deposit_request`, `followup`.

## 6. Outlook (Microsoft Graph)

- App Azure AD (client id/secret, tenant). Redirect `MICROSOFT_REDIRECT_URI`.
- `/api/integrations/microsoft/connect` → URL d'autorisation ; `/callback` → échange du code, stockage chiffré ; `/status`, `/sync`, `/disconnect`.
- Appels Graph : `GET /me/mailFolders/inbox/messages/delta` (synchronisation incrémentale, curseur local), `GET /me/messages/{id}`, `GET /me/messages?$filter=conversationId eq '…'`, `GET /me/messages?$search=…`, `GET /me/messages/{id}/attachments`, `POST /me/messages/{id}/reply`, `POST /me/messages/{id}/forward`, `POST /me/sendMail`.
- Refresh token automatique avant expiration ; erreur 401 → `refresh` puis retry unique. Détails : `docs/outlook.md`.

## 6 bis. Comptes utilisateurs et multi-client (18/09/2026)

```
WhatsApp personnel du dirigeant ──▶ numéro WhatsApp Business EMA ──▶ webhook Meta (signé)
   ──▶ identifySender(from) : E.164 → users.phone_number (vérifié, activé)
         ├─ inconnu      → message d'onboarding (borné), aucun appel Microsoft, aucune donnée
         ├─ en attente   → activation (phone_verified = 1) + bienvenue
         └─ utilisateur  → router (boutons / décision naturelle / assistant) avec userId
   ──▶ tools (ToolContext.userId) ──▶ connections[user_id, microsoft] ──▶ Microsoft Graph (SA boîte)
   ──▶ réponse WhatsApp vers le numéro de l'utilisateur
```

- `users` : `id`, `organization_id` (réservé), `email` (unique), `password_hash`, `role`, `status`, `phone_number` (E.164, unique parmi les actifs), `phone_verified`, `whatsapp_enabled`, `verified_at`.
- `connections` : `user_id`, `provider`, `encrypted` (tokens AES-256-GCM), `scopes`, `expires_at`, `provider_account_email`, `status` (`active` / `revoked`). Remplace `oauth_tokens` (migration `010_users` ; une connexion héritée sans compte est adoptée par le premier compte créé).
- `user_id` sur `emails`, `documents`, `actions`, `scheduled_followups`, `chat_messages`, `history` ; hérité automatiquement de l'email source (actions, documents, relances) ou fixé par le serveur (chat, WhatsApp).
- Lecture : toutes les listes acceptent `userId` ; les routes API et pages le passent depuis la session ; les tools via `assertOwned` / `ToolContext.userId`. Exécution : chaque exécuteur reçoit `ctx.userId` et n'utilise que la connexion du propriétaire de l'action.
- Web et WhatsApp partagent le même `user_id` ; les conversations sont séparées par canal et par utilisateur.
- Ajouter un client : compte (`/login` → « Créer un compte », ou `ALLOW_SIGNUP=true`), Outlook (Paramètres → Connexions), numéro puis premier message WhatsApp. Aucune modification de code.

## 7. WhatsApp

- Envoi : `POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages` type `interactive` (boutons `✅ Valider`, `❌ Refuser`), texte long en message séparé si nécessaire. Client centralisé `src/integrations/whatsapp/client.ts` (retries 429/5xx bornés).
- Réception : `GET /api/integrations/whatsapp/webhook` (vérification `hub.verify_token`), `POST` (signature `X-Hub-Signature-256`, événements `button_reply`).
- Le `button.id` = `approve:<approval_id>` / `reject:<approval_id>`. La modification d'un brouillon se fait depuis l'interface (page À valider).
- Service `src/integrations/whatsapp/approvals.ts` : notification unique par approval envoyée au numéro vérifié du **propriétaire de l'action**, décision via l'Action Engine (`approveAndExecute` / `rejectAction`) réservée à ce propriétaire, dédoublonnage `webhook_events`. Identification des expéditeurs : `router.ts` (`identifySender`). Activation : `activation.ts`. Détails : `docs/whatsapp.md`.

## 8. Signatures / tampons (Phase 5)

- `src/documents/sign.ts` : `checkSignatureReadiness()` (QUOTE uniquement, société, assets, expiration, RIB, montant), `prepareQuoteSignature()` (action `sign_document` CRITICAL, idempotente par document), `createSignedCopy()` (idempotente, empreinte de l'original revérifiée, assets chargés depuis `private/`, nouveau fichier `private/signed-documents/<yyyy>/<mm>/`), `markSignedDocumentSent()`.
- `src/documents/sign-pdf.ts` : `buildSignedPdf()` (pdf-lib, fonction pure). `APPEND_APPROVAL_PAGE` (page d'accord ajoutée) par défaut ; `OVERLAY_LAST_PAGE` uniquement avec coordonnées configurées dans `config/companies.json`.
- `src/documents/assets.ts` : chargement et vérification des PNG (chemin, magic bytes, IHDR, dimensions, 2 Mo max).
- `src/actions/executors/signing.ts` : exécuteur `sign_document` — copie signée → réponse dans le thread (`/reply`) avec le seul PDF signé → statuts `signed_and_sent` / `sent` → `history`.
- Claude ne voit que `company_id` et des libellés logiques ; un seul tool `prepare_signed_document` (crée l'action) ; `apply_signature` / `apply_stamp` n'existent pas comme tools. Détails : `docs/signatures.md`.

## 9. Assistant WhatsApp (Phase 6)

- `src/integrations/whatsapp/router.ts` : point d'entrée unique du webhook. Ordre invariant — numéro autorisé → assistant activé (`WHATSAPP_ASSISTANT_ENABLED`) → dédoublonnage `webhook_events` → routage `APPROVAL_INTERACTION` (service d'approbations phase 3) ou `CHAT_MESSAGE`.
- Décision en langage naturel (`parseNaturalDecision`) : déterministe, appliquée via l'Action Engine uniquement si une action attend une décision ; plusieurs actions → liste numérotée et désambiguïsation.
- `src/agent/whatsapp-assistant.ts` : tour de conversation réutilisant `runChatTurn` (canal `WHATSAPP`), liste d'outils explicite, contexte borné (8 derniers messages, actions en attente, références).
- `src/agent/references.ts` : références numérotées enregistrées avec la réponse (`chat_messages.refs`) pour résoudre « le premier », « le deuxième », « réponds-lui ».
- Après une préparation, le routeur envoie la réponse courte puis la carte de validation habituelle (`notifyPendingApproval`). Détails : `docs/whatsapp-assistant.md`.

## 10. Relances intelligentes (Phase 7)

- `src/followups/schedule.ts` : intention temporelle → instant réel (fuseau du client, heure par défaut, jours ouvrés). Le modèle ne produit jamais d'horodatage.
- `src/followups/detect.ts` : classification déterministe d'une réponse (humaine / automatique / ambiguë) et détection d'un message sortant plus récent, à partir de l'ancrage `watch_after`.
- `src/followups/draft.ts` : contexte borné (thread encapsulé, raison, tentative) → sortie structurée `followupProposalSchema`.
- `src/followups/service.ts` : programmation, traitement des échéances (verrou atomique `SCHEDULED → CHECKING`, vérification Microsoft Graph obligatoire), création de l'action `reply_email`, réconciliation avec l'Action Engine, report, annulation, rappels internes, notifications proactives.
- Tâche worker `process_followups` (5 min, sous verrou SQLite). Détails : `docs/followups.md`.

## 10 bis. Durcissement (phase 8A)

Aucune nouvelle fonctionnalité métier : fiabilité, idempotence et reprise.

- `src/lib/content-safety.ts` — politique de restitution des fichiers privés (PDF en ligne, tout le reste en pièce jointe neutralisée).
- `src/integrations/microsoft/graph-client.ts` — `RequestOptions.idempotent` ; un `POST` d'envoi n'est jamais rejoué sur coupure réseau ou 5xx (`DeliveryAmbiguousError`, code `DELIVERY_AMBIGUOUS`) ; seuls 401 (rejet avant traitement) et 429 sont rejoués.
- `src/integrations/microsoft/reconcile.ts` — recherche de l'envoi réel dans les éléments envoyés : verdict `sent` / `not_sent` / `unknown`, jamais de conclusion à partir d'une lecture Graph ratée.
- `src/actions/recovery.ts` — `recoverStaleActions()` (tâche worker toutes les 60 s) : `APPROVED` jamais exécutée → exécution ; `EXECUTING` interrompue → réconciliation ; document déjà signé → jamais re-signé.
- `src/agent/recipients.ts` — résolution `contact_id → adresse` et `validateOutboundRecipients()` appelé dans chaque exécuteur d'envoi.
- `src/database/repositories/webhook-events.ts` — `claimWebhookEvent()` atomique, statut `RECEIVED → PROCESSING → PROCESSED | FAILED`, verrou de 120 s, reprise contrôlée après crash.
- `src/database/repositories/locks.ts` — propriétaire unique par exécution, `renewLock` / `releaseLock` / `currentLock`.
- `src/security/rate-limit.ts` — limitation persistée (table `rate_limits`).
- `src/documents/extract-text.ts` — extraction PDF dans un *worker thread* réellement arrêtable.
- Migration `009_hardening` : `actions.error_code`, cycle de vie des `webhook_events`, table `rate_limits`.

## 11. Déploiement

Ubuntu VPS : Node 20+, PM2 (`ema-web`, `ema-worker`), Nginx reverse proxy, Certbot HTTPS. Voir `docs/deployment.md`.
