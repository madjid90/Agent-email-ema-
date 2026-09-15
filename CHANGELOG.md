# CHANGELOG

Toutes les modifications notables d'EMA sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).

## [0.3.0] — Phase 2 — Claude / compréhension des emails — 2026-09-15

### Ajouté
- Intégration Anthropic réelle : `runStructured()` (sortie structurée zod via `messages.parse`, prompt système mis en cache, effort configurable), `LlmError` typée (auth, rate_limit, transient, timeout, invalid_response, refusal, not_found), journal `llm_runs`.
- Context Engine (`src/agent/context.ts`) : contexte borné et structuré en données fiables / contenu non fiable encapsulé ; thread, sociétés, contacts, règles présélectionnées, pièces jointes, analyses précédentes du même expéditeur.
- Schéma d'analyse `EmailAnalysis` (catégories `INVOICE`… `OTHER`, urgence `LOW`… `CRITICAL`, montant/devise, `needs_reply`, `requires_human_review`, `reply_draft`, `reasoning_summary`, `injection_suspected`) et garde-fous `applyGuards()`.
- Moteur de règles `src/agent/rules.ts` (évaluation en code, destinataire de transfert issu de la configuration, présélection avant analyse).
- Orchestrateur `analyzeEmail()` / `analyzePendingEmails()` : transition atomique `NEW → ANALYZING → ANALYZED | ANALYSIS_FAILED`, réanalyse forcée, action `prepare_reply` sans effet, historique.
- Chat EMA (`src/agent/chat.ts`) : Claude avec outils de lecture uniquement, boucle bornée ; tools `get_email_analysis`, `list_recent_emails`.
- Worker : tâche `analyze_emails`, analyse déclenchée après chaque scan.
- Routes `POST /api/emails/{id}/analyze` (réanalyse), `GET /api/emails/{id}/analysis`, `POST /api/chat` réel.
- Interface : analyses réelles dans Emails, détail d'email (carte d'analyse, brouillon, justification, règles, appels Claude), Aujourd'hui (compteurs et priorités issus des analyses), Paramètres (seuils de confiance, effort, taille du thread), boutons Analyser / Réanalyser.
- Migration `003_analysis` : statuts d'analyse, `email_analyses` reconstruite (nouvelles colonnes, catégories en majuscules), table `llm_runs`.
- `settings.analysis` (`reliableThreshold`, `reviewThreshold`, `effort`, `maxThreadMessages`), `docs/analysis.md`, 28 nouveaux tests avec Anthropic mocké (dont prompt injection, réponse invalide, timeout, 429, doublon, CONTEXT ignoré, réanalyse).

### Modifié
- Catégories d'emails en majuscules dans `config/rules.json` (anciennes valeurs converties automatiquement), `BUSINESS_RULES.md`, `TOOLS.md`.
- `emails.status` sans contrainte CHECK SQL (validation TypeScript).
- Mode `chat` des tools restreint à la lecture (`CHAT_READONLY_TOOLS`) jusqu'à la phase 3.

## [0.2.0] — Phase 1 — Outlook / Microsoft Graph — 2026-09-15

### Ajouté
- OAuth Microsoft complet : `connect`, `callback`, `status`, `sync`, `disconnect` sous `/api/integrations/microsoft/`, état anti-CSRF à usage unique, tokens chiffrés dans `oauth_tokens`, refresh proactif (marge 2 min) et sur 401.
- Client Graph centralisé (`src/integrations/microsoft/graph-client.ts`) : gestion 401/429 (Retry-After)/5xx/réseau, pagination, `GraphError` assainie.
- Synchronisation delta de la boîte de réception (`sync.ts`) : curseur local, première synchro bornée (`EMAIL_INITIAL_SYNC_DAYS`), limite par passage (`EMAIL_SYNC_LIMIT`), dédoublonnage `graph_id`, mise à jour lu/non lu.
- Threads via `conversationId` importés en statut `CONTEXT`, recherche `$search`, `htmlToText` de secours.
- Pièces jointes : liste, téléchargement `$value`, refus des extensions/MIME dangereux et des fichiers > `ATTACHMENT_MAX_MB`, stockage `private/documents/yyyy/mm/`, SHA-256, index unique `(email_id, attachment_id)`.
- Exécuteurs Outlook (`src/actions/executors/outlook.ts`) : `reply_email`, `forward_email`, `send_email`, `payment_request`, `deposit_request` via Graph, appelés uniquement par l'Action Engine après validation ; trace du message envoyé (Sent Items).
- Tools réels : `get_new_emails`, `get_email` (liste des pièces jointes), `get_email_thread`, `search_emails`, `get_attachment`.
- Worker : tâche `scan_mailbox` réelle ; route de synchronisation manuelle partageant le même verrou.
- Interface : panneau Outlook (connecté, adresse, permissions, dernière synchronisation, dernier email, Tester / Synchroniser / Déconnecter) dans Setup et Paramètres ; bouton Synchroniser et état sur la page Emails ; pièces jointes téléchargeables et lien « Ouvrir dans Outlook » sur le détail d'un email.
- Migration `002_outlook` : colonnes `internet_message_id`, `cc_recipients`, `sent_at`, `is_read`, `web_link`, `folder`, statut `CONTEXT` ; `documents.stored_name`, `documents.sha256`.
- `docs/outlook.md`, 28 nouveaux tests (Graph mocké, aucun email réel).

### Modifié
- Permissions Graph réduites à `offline_access User.Read Mail.Read Mail.Send` (plus de `Mail.ReadWrite`).
- `runMigrations` désactive `foreign_keys` pendant une migration et vérifie `foreign_key_check` (reconstruction de table).
- `.env.example` : `MICROSOFT_REDIRECT_URI` vers `/api/integrations/microsoft/callback`, `EMAIL_SYNC_LIMIT`, `EMAIL_INITIAL_SYNC_DAYS`, `ATTACHMENT_MAX_MB`.

### Supprimé
- Route provisoire `/api/outlook/connect` (phase 0).

## [0.1.0] — Phase 0 — 2026-09-15

### Ajouté
- Documentation de référence : `CLAUDE.md`, `ARCHITECTURE.md`, `BUSINESS_RULES.md`, `TOOLS.md`, `SECURITY.md`, `ROADMAP.md`, `README.md`, `docs/deployment.md`.
- Squelette Next.js 15 + TypeScript strict, ESLint, Vitest, scripts `dev/build/start/lint/typecheck/test/check`.
- `.env.example` et `.gitignore` (secrets, `data/`, `private/`, `config/*.json` réels exclus).
- Fichiers de configuration d'exemple (`config/*.example.json`) et chargeur validé par zod.
- SQLite (`better-sqlite3`) : migrations, connexion WAL, repositories typés.
- Action Engine : statuts, niveaux de risque, règle de validation obligatoire, transitions atomiques (idempotence), tests.
- Couche tools : `defineTool()`, registre, contrats zod de tous les tools prévus.
- Prompt agent `src/agent/ema.md`, schéma `EmailAnalysis`, squelette `context.ts` / `orchestrator.ts`.
- Sécurité : `wrapUntrusted()`, chiffrement AES-256-GCM des tokens, session UI par mot de passe.
- Interface : layout + navigation complète, pages de base, `/setup` 8 étapes, `/api/health`, `/api/status`.
- Worker : boucle de scheduler avec verrous SQLite.
- Scripts `scripts/backup.sh`, `scripts/restore.sh`, `ecosystem.config.cjs` (PM2).

### Notes
- Les intégrations Outlook, Claude (analyse), WhatsApp, PDF sont des contrats typés avec des implémentations de phase ultérieure (`NotImplementedError` explicite).
