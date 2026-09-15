# CHANGELOG

Toutes les modifications notables d'EMA sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).

## [0.8.0] — Phase 7 — Relances intelligentes et rappels internes — 2026-09-15

### Ajouté
- Module `src/followups/` : `schedule.ts` (échéances calculées côté serveur à partir d'une intention — « dans 3 jours », « vendredi », date explicite, heure par défaut, jours ouvrés), `detect.ts` (classification déterministe réponse humaine / automatique / ambiguë, détection d'un message sortant plus récent, ancrage `watch_after`), `draft.ts` (contexte borné + sortie structurée `followupProposalSchema`), `service.ts` (programmation, traitement des échéances, réconciliation, report, annulation, rappels, notifications).
- Migration `008_followups` : `scheduled_followups` reconstruite avec `kind`, `watch_after`, `company_id`, `document_id`, `title`, `generated_action_id`, `last_reply_email_id`, `requires_human_review`, `notification_pending`, `notify_attempts`, `notified_at`, `last_checked_at`, `last_error`, `cancellation_reason`, `created_by`, `updated_at` ; machine d'état à 13 statuts (données existantes conservées, `COMPLETED` → `SENT`).
- Vérification Microsoft Graph **obligatoire** à l'échéance : sans vérification possible, la relance repasse en `CHECK_FAILED` et rien n'est envoyé ni préparé.
- Brouillon de relance contextualisé (ton adapté à la tentative) → action `reply_email` dans le thread existant, `followup_id` et `attempt` dans le payload, validation obligatoire ; relance financière conservée en HIGH.
- Carte WhatsApp dédiée « 🔁 EMA — Relance à valider » (contact, sujet, dernier message envoyé, réponse reçue, tentative) ; modification du brouillon via `update_draft`.
- Rappels internes (`INTERNAL_REMINDER`) : notification WhatsApp avec boutons `Terminé` / `Reporter` traités par le routeur, sans aucun email.
- Notifications proactives : dédoublonnage par `notified_at`, bascule sur un template Meta hors fenêtre de 24 h (`WHATSAPP_FOLLOWUP_TEMPLATE_NAME`, `WHATSAPP_FOLLOWUP_TEMPLATE_LANG`), sinon `notification_pending` visible dans l'interface — jamais comptée comme envoyée.
- Tools `list_followups`, `postpone_followup`, `prepare_followup_now`, `complete_reminder` ; `schedule_followup` prend désormais une intention temporelle et non une date. Pilotage WhatsApp complet avec références multi-tours (« prépare le premier »).
- `settings.followups` (`enabled`, `defaultDelayDays`, `defaultTime`, `maxAttempts`, `businessDaysOnly`, `requireApproval`, `autoReplyPostponeDays`).
- Page Relances complète (À traiter, En attente de validation, Aujourd'hui, À venir, Envoyées, Annulées ; Voir le thread, Préparer maintenant, Reporter, Annuler, Terminé) et compteurs sur Aujourd'hui (relances du jour, à valider, réponses reçues, suivis sans réponse, rappels).
- `docs/followups.md` ; 34 nouveaux tests (224 au total).

### Modifié
- Tâche worker `process_followups` : réconciliation, traitement des échéances sous verrou, reprise des vérifications interrompues, renvoi des notifications en attente.
- `reply_email` accepte `followup_id` et `attempt` ; `setAnthropicClientForTests` ajouté pour les tests.
- `CLAUDE.md` §10 bis, `BUSINESS_RULES.md` §7, `TOOLS.md`, `ARCHITECTURE.md` §10, `SECURITY.md` §4 ter, `ROADMAP.md` (VPS en phase 8).

## [0.7.0] — Phase 6 — Pilotage complet d'EMA depuis WhatsApp — 2026-09-15

### Ajouté
- **WhatsApp Router** (`src/integrations/whatsapp/router.ts`) : point d'entrée unique du webhook — numéro autorisé → assistant activé → dédoublonnage Meta → boutons (service d'approbations phase 3, inchangé) ou messages texte (assistant conversationnel).
- **Assistant WhatsApp** (`src/agent/whatsapp-assistant.ts`) réutilisant le Chat EMA : lecture (questions sur emails, documents, contacts, sociétés, actions, point du jour), préparation (brouillons) et action (via l'Action Engine). Aucune commande à retenir.
- Liste d'outils explicite `WHATSAPP_TOOLS` : 12 outils de lecture et 8 outils de préparation ; aucune primitive d'envoi, de signature ou d'approbation n'est exposée.
- Nouveaux tools : `search_contacts` (contacts configurés puis expéditeurs reçus, aucune adresse inventée), `get_company` (disponibilité de la signature/du tampon, jamais de chemin), `get_today_summary` (compteurs du jour), `update_draft` (modification du texte d'un brouillon en attente), `prepare_document_forward` (transfert d'un document au destinataire désigné par `config/rules.json`).
- Mémoire conversationnelle multi-tours dans `chat_messages` (migration `007_whatsapp_chat` : `channel`, `external_id`, `sender` masqué, `refs`, `email_id`, `document_id`, `action_id`) et module `src/agent/references.ts` — résolution de « le premier », « le deuxième », « réponds-lui ».
- Validation en langage naturel déterministe (« valide », « oui envoie », « annule », « refuse ») appliquée uniquement quand une action attend une décision ; plusieurs actions en attente → liste numérotée et désambiguïsation par numéro.
- Contexte borné par tour : 8 derniers messages du canal, 5 actions en attente, références de la dernière réponse, prompt `whatsapp.md`.
- `WHATSAPP_ASSISTANT_ENABLED` (défaut `true`) : à `false`, les messages texte sont ignorés et les validations par boutons continuent de fonctionner ; état affiché dans Paramètres → WhatsApp.
- `docs/whatsapp-assistant.md` ; 31 nouveaux tests (190 au total) : numéro non autorisé, doublon, questions, contacts ambigus, rédaction, modification de brouillon, transfert par règle, demande de règlement, devis « le premier » → signature CRITICAL, validations et refus naturels, double validation, erreurs Claude / Outlook / WhatsApp, injection, aucune action hors Action Engine.

### Modifié
- `runChatTurn` accepte un canal, une liste d'outils, un contexte additionnel et un observateur de résultats : le Chat EMA de l'interface est inchangé.
- Le webhook appelle `handleWhatsappEvent` au lieu de `handleInboundEvent` (le traitement des boutons reste identique).
- `ARCHITECTURE.md` §9, `BUSINESS_RULES.md` §6 bis, `TOOLS.md`, `SECURITY.md` §4 bis, `CLAUDE.md` §9, `ROADMAP.md` (les relances passent en phase 7, le VPS en phase 8).

## [0.6.0] — Phase 5 — Devis / bon pour accord / signature graphique / tampon — 2026-09-15

### Ajouté
- Schéma d'extraction étendu pour les devis : `quote_number`, `valid_until`, `subject`, `payment_terms`, `delivery_or_service_date`, `signature_requested` ; garde-fous déterministes : `QUOTE_EXPIRED` (revue humaine), montant absent, société inconnue/ambiguë → `company_id = null`, contrat → « Document contractuel détecté — traitement manuel requis. ».
- `config/companies.json` : `legalName`, `email`, `quoteApprovalText`, `stampRequired`, `signaturePlacement` (`APPEND_APPROVAL_PAGE` | `OVERLAY_LAST_PAGE` avec coordonnées) ; `settings.signature` (`warningAmount`, `replySubjectPrefix`, `replyTemplate`).
- `src/documents/assets.ts` (PNG vérifiés : chemin, magic bytes, IHDR, dimensions, 2 Mo), `src/documents/sign-pdf.ts` (pdf-lib, page d'accord ajoutée ou superposition configurée, PDF chiffré/corrompu refusé), `src/documents/sign.ts` (`checkSignatureReadiness`, `prepareQuoteSignature`, `createSignedCopy` idempotente avec empreinte vérifiée, `markSignedDocumentSent`).
- Exécuteur `sign_document` (`src/actions/executors/signing.ts`) : copie signée → réponse dans le thread avec le seul PDF signé → statuts → `history` ; nouvel essai après échec Graph sans second PDF.
- Payload `sign_document` déterministe (identifiants, société, fournisseur, référence, montants, texte d'accord, libellés logiques, stratégie de placement, réponse) — jamais de chemin, d'image ni de base64.
- Orchestrateur : email `DOCUMENT_TO_SIGN` / `signature_requested` + PDF `QUOTE` → action CRITICAL + WhatsApp « 📄 EMA — Devis à signer » (étapes ✓, avertissements expiration / RIB / montant élevé, note « appliquera réellement votre signature enregistrée »).
- Tool unique `prepare_signed_document({ document_id, company_id })` (modes analyse et chat) ; chat : « J'ai préparé la demande de signature. Une validation est requise. », refus de toute signature automatique.
- Interface : aperçu « Devis à signer » et « ✅ Devis signé » dans À valider, statuts Documents (À analyser, Analysé, À valider, Refusé, Signé, Envoyé, Échec), onglet « Devis signés », colonne validité, chaîne original → copie signée dans le détail, éditeur Sociétés (texte d'accord, placement, tampon obligatoire).
- Migration `006_signatures` (`quote_number`, `valid_until`, `subject`, `parent_document_id`, `signed_document_id`, `signed_action_id`, `signed_approval_id`, `sent_at`) ; `todayInTimezone` / `formatDateOnly`.
- `docs/signatures.md` ; 19 tests (`tests/signing.test.ts`, fixtures PNG/PDF générées en mémoire).

### Modifié
- Tools `apply_signature` / `apply_stamp` supprimés : l'application de la signature est interne à l'exécuteur.
- `.gitignore` : motifs `documents/`, `signatures/`, `stamps/`, `signed-documents/`, `tokens/` ancrés à la racine — ils masquaient `src/documents/`, `src/tools/documents/`, `src/tools/signatures/`, `src/app/(app)/documents/` et `src/app/api/documents/`, absents des commits précédents ; ces fichiers sont désormais versionnés.
- `BUSINESS_RULES.md` §6, `TOOLS.md`, `SECURITY.md`, `ARCHITECTURE.md` §8, `CLAUDE.md` §10, `ROADMAP.md`.

## [0.5.0] — Phase 4 — Factures / demandes de paiement / acomptes — 2026-09-15

### Ajouté
- Document Engine `src/documents/` : `extract-text.ts` (pdf-parse v2, contrôles MIME/taille/signature, PDF sans texte → revue humaine), `classify.ts` (heuristique, IBAN, changement de RIB), `types.ts` (types documentaires, schéma d'extraction zod), `invoice.ts` (garde-fous déterministes, doublons), `analyze.ts` (Claude en sortie structurée, persistance, historique), `routing.ts` (actions financières déterministes).
- Prompt `analyze-document.md` ; contenu des documents encapsulé dans `<untrusted_document_content>`.
- Orchestrateur : analyse des PDF après l'analyse email, puis `forward_email` (règle) ou `payment_request` / `deposit_request` (contact comptable) en `WAITING_APPROVAL` + WhatsApp ; une seule action financière active par email.
- Messages WhatsApp enrichis (fournisseur, facture, montant, échéance, doublon, RIB, note « aucun paiement bancaire »).
- Tools documents réels + `search_documents`, `get_document`, `list_pending_actions` ; chat étendu aux données documentaires, refus explicite de toute action bancaire.
- Routes `GET /api/documents`, `GET /api/documents/{id}`, `POST /api/documents/{id}/analyze` (chemin privé jamais exposé).
- Interface : page Documents branchée (onglets, recherche, statuts), page détail d'un document, pièces jointes analysées dans le détail d'un email, compteurs et alertes sur Aujourd'hui, détails facture dans À valider.
- Worker : tâche `analyze_documents`.
- Migration `005_documents` (type, statut d'extraction, données facture dénormalisées, doublons, changement de RIB).
- Dépendances `pdf-parse`, `pdf-lib` ; 22 nouveaux tests (fixtures PDF générées, Anthropic/WhatsApp/Graph mockés) ; `docs/documents.md`.

### Modifié
- `BUSINESS_RULES.md` §4-5, `TOOLS.md`, `SECURITY.md`, `CLAUDE.md`, `ROADMAP.md`.
- Tests exécutés sans parallélisme inter-fichiers (dossier privé partagé).

## [0.4.0] — Phase 3 — WhatsApp / validation / exécution — 2026-09-15

### Ajouté
- Intégration WhatsApp Business Cloud API : `client.ts` (envoi, retries bornés, `WhatsappError`), `messages.ts` (message de validation compact + boutons interactifs), `webhook.ts` (vérification d'abonnement, signature HMAC, parsing zod, identifiants de boutons), `approvals.ts` (notification unique par approval, relance, traitement des décisions via l'Action Engine, dédoublonnage).
- Routes `GET/POST /api/integrations/whatsapp/webhook`, `GET /api/integrations/whatsapp/status`, `POST /api/integrations/whatsapp/test` (message réel « ✅ EMA est correctement connecté à WhatsApp. »).
- Routes actions : `PUT /api/actions/{id}/payload` (brouillon modifié manuellement), `POST /api/actions/{id}/notify` (renvoyer la demande), `POST /api/actions/{id}/retry` (nouvelle tentative après échec).
- Action Engine : `createApprovalRequest()`, `editActionPayload()`, `retryAction()` ; l'expiration laisse l'action en attente (jamais exécutée sans décision).
- Analyse → action `reply_email` en `WAITING_APPROVAL` + demande WhatsApp ; réanalyse met à jour la réponse en attente sans doublon.
- Worker : tâche `notify_approvals` (demandes jamais parties, 5 tentatives max).
- Interface : composant `ApprovalCard` (Modifier / Valider et envoyer / Refuser / Renvoyer la demande / Réessayer l'envoi, statuts), page À valider branchée (décisions récentes incluses), panneau WhatsApp dans Setup et Paramètres.
- Migration `004_whatsapp` (`approvals.notify_attempts/sent_at/last_notify_error`, table `webhook_events`).
- Variables `WHATSAPP_APPROVER_PHONE` (alias de `WHATSAPP_RECIPIENT_NUMBER`), `WHATSAPP_APP_SECRET`, `WHATSAPP_API_VERSION`.
- `docs/whatsapp.md`, 18 nouveaux tests (WhatsApp et Graph mockés, aucun message ni email réel).

### Modifié
- `expireApprovals` ne rejette plus l'action : approval `EXPIRED`, action `WAITING_APPROVAL`, renvoi possible.
- Composant `action-buttons.tsx` remplacé par `approval-card.tsx`.
- `SECURITY.md`, `ARCHITECTURE.md`, `CLAUDE.md` §9, `docs/deployment.md`.

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
