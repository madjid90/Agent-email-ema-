# CHANGELOG

Toutes les modifications notables d'EMA sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).

## [Non publié] — POC Outlook via Composio (lecture seule, branche `poc/composio-outlook`)

Test technique isolé, désactivé par défaut (`COMPOSIO_POC_ENABLED=false` → EMA inchangé). Client REST v3.1 (`src/integrations/composio/client.ts`, URL officielle `https://backend.composio.dev`, SDK écarté : Node ≥ 22.22.3 requis), politique lecture seule fail-closed avec **table déterministe de slugs Outlook actuels** (`policy.ts`), service par utilisateur (`outlook-poc.ts`), migration `011_composio_poc` (références uniquement, aucun token), routes `/api/poc/composio/*`, page `/poc/composio`. Corrections d'audit : `input_parameters` v3.1 (mapping direct) + forme JSON Schema, slugs `OUTLOOK_*` actuels (jamais un tool de calendrier pour une pièce jointe de message), **Callback Identity Verification** (`complete_auth`, obligatoire en production, mode callback local toléré en développement seulement), auth config Composio Managed OAuth lecture seule documentée. 29 tests mockés (réponses v3.1). Procédure : `docs/composio-poc.md`.

## [1.1.0] — Assistant multi-dirigeants : comptes, Outlook par utilisateur, WhatsApp EMA central — 2026-09-18

Changement de modèle : une instance héberge plusieurs comptes ; chaque dirigeant connecte SA boîte Outlook et parle à EMA depuis son WhatsApp personnel vers UN numéro WhatsApp Business EMA. Le moteur (tools, Action Engine, validations, réconciliation, worker) est conservé.

### Ajouté
- **Comptes utilisateurs** (`users`, migration `010_users`) : email + mot de passe (scrypt, 12 caractères minimum), rôle `owner` / `user`, numéro de téléphone **E.164** normalisé (`src/lib/phone.ts`), `phone_verified`, `whatsapp_enabled`, `verified_at`. Numéro unique parmi les comptes actifs. Inscription depuis `/login` (premier compte libre, suivants si `ALLOW_SIGNUP=true`), connexion `POST /api/auth/login` (email + mot de passe), `POST /api/auth/register`, `GET /api/me`.
- **Connexions Microsoft par utilisateur** (`connections`, remplace `oauth_tokens`) : tokens chiffrés AES-256-GCM, `provider_account_email`, `expires_at`, `status` (`active` / `revoked`). L'état OAuth anti-CSRF mémorise l'utilisateur qui lance le flux ; le callback lui attribue les tokens et revient sur Paramètres → Connexions. Scopes délégués `openid profile offline_access User.Read Mail.Send Mail.Read`. Refresh refusé (`invalid_grant`, `interaction_required`…) → connexion `revoked`, code **`MICROSOFT_RECONNECT`**, message « Votre connexion Microsoft a expiré ou a été révoquée. Reconnectez Outlook. »
- **WhatsApp EMA central** : le webhook identifie l'expéditeur par son numéro (`identifySender`) ; numéro inconnu → message d'onboarding borné (3 / h), aucun appel Microsoft ni Claude, journal sans numéro complet (`UNKNOWN_USER`) ; numéro enregistré non vérifié → **activation** au premier message (« Bonjour EMA ») + bienvenue ; numéro désactivé → invitation à réactiver. `POST/DELETE /api/me/phone`, `src/integrations/whatsapp/activation.ts` (lien `wa.me` prérempli vers `WHATSAPP_BUSINESS_NUMBER`).
- **Isolation par `user_id`** sur `emails`, `documents`, `actions`, `scheduled_followups`, `chat_messages`, `history` (héritage automatique depuis l'email source). `ToolContext.userId` fixé par le serveur, `assertOwned()` dans les tools, `ownedOr404()` dans les routes, listes filtrées dans les pages. Chaque exécuteur, la reprise et les relances utilisent la connexion du **propriétaire** de l'action. Un appel non scopé n'obtient une connexion que si l'instance n'en a qu'une seule.
- **Worker** : synchronisation de **chaque** boîte connectée, curseur et état par utilisateur (`syncKeys`), une boîte en erreur n'empêche pas les autres. Notifications WhatsApp (validations, relances) envoyées au numéro vérifié du propriétaire.
- **Interface** : `/login` (connexion / création de compte), **Paramètres → Connexions** (Outlook : Connecter / Connecté ✅ adresse / Déconnecter ; WhatsApp : numéro → Continuer → « Ouvrir WhatsApp » → Activé ✅ / Désactiver), nom du compte dans la navigation.
- **Diagnostic** : contrôle « utilisateurs » (comptes, WhatsApp activés) et « Outlook » (boîtes connectées) ; journaux `whatsapp message identified` → `assistant turn` → tools → `reply sent`.
- 17 tests (`tests/multi-user.test.ts`, 317 au total) couvrant les scénarios A (activation), B/F (deux utilisateurs simultanés, aucune fuite), C/D (recherche puis réponse validée envoyée depuis la bonne boîte), E (numéro inconnu), G (refresh), H (token révoqué), l'isolation des tools et du chat web.

### Modifié
- `APP_PASSWORD` et `WHATSAPP_APPROVER_PHONE` sont **obsolètes** (avertissement seulement ; le second ne sert plus qu'au message de test). WhatsApp est « configuré » avec token + numéro + verify token, sans numéro autorisé.
- `CLAUDE.md` : décision multi-utilisateur consignée (remplace « une instance = une boîte »), règle 2 bis (identité serveur), §8 et §9 mis à jour. `ARCHITECTURE.md` §6 bis, `SECURITY.md` §1 bis, `docs/deployment.md` §7 bis, `docs/outlook.md`, `docs/whatsapp.md` §0, `docs/client-onboarding.md`.
- Tests existants alignés : codes `MICROSOFT_RECONNECT`, scopes, état OAuth structuré, sessions porteuses du compte, numéro inconnu → `unknown_user`.

### Migration
- `010_users` : crée `users` et `connections`, copie l'ancienne ligne `oauth_tokens` dans `connections` (sans propriétaire, adoptée automatiquement par le premier compte créé), supprime `oauth_tokens`, ajoute `user_id` + index sur les tables métier. Les lignes antérieures restent `NULL` et visibles uniquement par un contexte non scopé.

## [1.0.2] — Phase 8A.1 — Corrections finales avant VPS — 2026-09-16

Corrections uniquement : aucune nouvelle fonctionnalité, aucun changement d'architecture.

### Corrigé
- **Worker** : `src/worker/index.ts` n'appliquait qu'une partie des contrôles de démarrage (ni `assertEnvUsable`, ni `hardenSensitiveFiles`, ni création des fichiers de configuration). Il utilise maintenant `bootstrap()`, exactement comme l'application web, de façon idempotente (aucun double enregistrement des exécuteurs et des tools). En production, une configuration bloquante **empêche le worker de démarrer** : message explicite et code de sortie 1.
- **`APP_PASSWORD`** : en production, un mot de passe de moins de 12 caractères devient une **erreur bloquante** au lieu d'un avertissement. Hors production, l'avertissement reste inchangé.
- **Restauration** : `restore.sh` poursuivait la restauration même quand la sauvegarde de sécurité de l'état courant échouait — l'état courant pouvait donc être écrasé sans filet. Elle est désormais obligatoire : en cas d'échec, la restauration est **annulée avant toute modification**, avec la cause affichée. Exception explicite : `--force-without-safety-backup`, précédée d'un avertissement en clair.
- **`X-Forwarded-For`** : plus jamais lu, y compris avec `TRUST_PROXY_HEADER=true`. Seul `X-Real-IP`, fixé par Nginx à `$remote_addr`, fait foi ; absent ou illisible, EMA retombe sur la clé globale. La configuration Nginx documentée réécrit `X-Forwarded-For` avec `$remote_addr` (au lieu de `$proxy_add_x_forwarded_for`) afin de ne jamais conserver une valeur fournie par le client.
- **Réconciliation** : un `conversationId` identique ne suffisait plus à conclure « envoyé » alors qu'un autre message du même fil pouvait correspondre. Selon le type d'action, EMA exige désormais aussi : réponse et relance → contenu réellement préparé + destinataire d'origine ; transfert → destinataire attendu ; devis signé → présence du PDF signé attendu (métadonnées de pièces jointes, lues avec `Mail.Read`, sans permission supplémentaire). Toute correspondance partielle donne `unknown` (vérification humaine demandée), jamais un faux `sent`, et jamais de second envoi automatique.
- **Ordonnanceur** : `stop()` n'annulait pas le premier tick différé (`setTimeout` de 1 s) ; une tâche pouvait donc démarrer après l'arrêt du worker, y compris sur une base déjà fermée. Les deux minuteries sont maintenant annulées.

### Ajouté
- `resetBootstrapForTests()` / `isBootstrapped()`, `resetDefaultExecutorsForTests()`, `listExecutorTypes()` : outillage de test, sans effet en production.
- 11 tests (300 au total) : refus de démarrage du worker en production, bootstrap unique, `APP_PASSWORD` bloquant, sauvegarde de sécurité en échec / réussie / forcée, réconciliation renforcée (contenu, destinataire, pièce jointe signée), contournement du rate limit par `X-Forwarded-For` impossible avec la configuration Nginx recommandée.

### Documentation
- `docs/deployment.md` (configuration Nginx et adresse client, restauration), `SECURITY.md` (§9 quater), `ROADMAP.md`.

## [1.0.1] — Phase 8A — Durcissement production — 2026-09-16

Aucune nouvelle fonctionnalité métier. Architecture des phases 0 à 8 inchangée.

### Sécurité
- **XSS documents** : un document archivé n'est plus jamais rendu dans l'origine EMA. Seul un PDF authentique (MIME **et** extension) est affiché en ligne ; HTML, SVG, XHTML, XML, `.eml`, `.swf`, `.wasm`… sont forcés en `application/octet-stream` + `Content-Disposition: attachment`, avec `nosniff`, CSP `default-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox`, `X-Frame-Options: DENY` et `Cache-Control: private, no-store` (`src/lib/content-safety.ts`). Un HTML piégé reçu en pièce jointe ne peut plus voler la session ni appeler les API authentifiées.
- **Sauvegardes chiffrées** : `BACKUP_ENCRYPTION_PASSWORD` active un chiffrement AES-256-GCM (clé dérivée par scrypt, `scripts/backup-crypto.cjs`, module `crypto` uniquement). L'archive en clair est effacée (`shred` si disponible), l'archive `.enc` est en `600`. En production, une sauvegarde non chiffrée est **refusée** sauf `--allow-plaintext`. La restauration déchiffre dans un dossier temporaire nettoyé, et s'arrête avant toute écriture si le mot de passe est incorrect ou l'archive altérée. Le mot de passe n'apparaît dans aucun journal ni message d'erreur.
- **Connexion** : limitation ramenée à 5 tentatives par 15 minutes avec blocage de 15 minutes, **persistée en SQLite** (table `rate_limits`) donc résistante à un redémarrage. `X-Forwarded-For` n'est plus lu par défaut (en-tête falsifiable) : uniquement si `TRUST_PROXY_HEADER=true`. Aucun mot de passe, aucune empreinte n'est stocké.
- **Pièces jointes sortantes** : `OUTGOING_ATTACHMENT_MAX_MB` (3 Mo par défaut) vérifié **avant** l'appel à Graph, avec demande d'envoi manuel — pas d'upload session, toujours aucune permission `Mail.ReadWrite`.

### Fiabilité
- **Envois non rejoués à l'aveugle** : `GraphClient` distingue requêtes idempotentes et envois. Une coupure réseau ou un 5xx pendant un `POST` d'envoi lève `DeliveryAmbiguousError` (`DELIVERY_AMBIGUOUS`, HTTP 502) au lieu d'être rejoué ; seuls un 401 (requête rejetée avant traitement, rejouée après rafraîchissement du token) et un 429 le sont.
- **Réconciliation Outlook** (`src/integrations/microsoft/reconcile.ts`) : avant toute nouvelle tentative, EMA cherche l'envoi réel dans les éléments envoyés. Correspondance forte seulement (même conversation, ou objet **et** destinataire) ; toute lecture Graph impossible donne `unknown`, jamais « non envoyé ». `sent` → action terminée sans renvoi, `unknown` → échec explicite et vérification humaine (bouton « J'ai vérifié, renvoyer » dans l'interface).
- **Reprise après interruption** (`src/actions/recovery.ts`, tâche worker toutes les 60 s) : une action `APPROVED` jamais exécutée repart ; une action `EXECUTING` interrompue est réconciliée, jamais rejouée ; un devis dont la copie signée existe n'est **jamais re-signé**.
- **Verrous worker** : un verrou actif n'est plus repris au motif que l'`owner` est identique ; chaque exécution a un propriétaire unique (`worker:tâche:run`). Ajout de `renewLock`, `releaseLock`, `currentLock`.
- **Événements entrants** : machine à états `RECEIVED → PROCESSING → PROCESSED | FAILED` avec verrou de 120 s et claim atomique (`claimWebhookEvent`). Un crash ne « perd » plus l'événement comme doublon ; un message texte interrompu déjà enregistré n'est jamais renvoyé à Claude — EMA demande de le renvoyer plutôt que de créer une seconde action.
- **Destinataires déterministes** : les tools WhatsApp exposent `prepare_send_email` / `prepare_forward_email` avec un `contact_id` (plus d'adresse libre) ; `validateOutboundRecipients()` revérifie chaque adresse juste avant l'envoi dans tous les exécuteurs (contact configuré, destinataire de règle, participant réel du thread, boîte du client).
- **Extraction PDF** : exécutée dans un *worker thread* réellement terminé au-delà de `PDF_EXTRACTION_TIMEOUT_SECONDS` (20 s) — un PDF pathologique ne monopolise plus le process.

### Ajouté
- Migration `009_hardening` : `actions.error_code`, cycle de vie des `webhook_events` (`status`, `attempts`, `started_at`, `processed_at`, `locked_until`, `last_error`), table `rate_limits`.
- Variables d'environnement `OUTGOING_ATTACHMENT_MAX_MB`, `PDF_EXTRACTION_TIMEOUT_SECONDS`, `TRUST_PROXY_HEADER`, `BACKUP_ENCRYPTION_PASSWORD` (documentées dans `.env.example`) ; contrôle « sauvegardes » dans `npm run doctor` (FAIL en production sans chiffrement).
- Intégration continue `.github/workflows/ci.yml` : Node 22, `npm ci`, `npm run check`, `npm audit --omit=dev --audit-level=high` (échec uniquement sur une vulnérabilité haute ou critique en runtime).
- 45 nouveaux tests de durcissement (`tests/hardening.test.ts`, 289 au total) : restitution des documents, refus non authentifié, idempotence Graph, réconciliation, verrous, cycle des webhooks, message interrompu, destinataires, reprise, limitation de connexion, sauvegarde chiffrée de bout en bout, délai d'extraction PDF, pièce jointe trop volumineuse. Aucun envoi réel, aucune donnée client, aucun secret réel.

### Documentation
- `SECURITY.md` (§9 sauvegardes chiffrées, §9 ter durcissement, checklist), `ARCHITECTURE.md` (§10 bis), `docs/deployment.md` (chiffrement, restauration, CI, blocage de livraison), `ROADMAP.md`.
- ⛔ **Blocage de livraison documenté** : le dépôt GitHub public doit être passé en privé **manuellement** avant tout déploiement commercial ; aucun code ne modifie la visibilité du dépôt.

## [1.0.0] — Phase 8 — Production ready (EMA V1) — 2026-09-16

Périmètre fonctionnel V1 gelé : aucune nouvelle fonctionnalité métier, hors l'import de signature/tampon depuis l'interface (finition attendue de la phase 5).

### Corrigé
- **Bloquant** : le worker PM2 et les scripts (`db:migrate`, `doctor`) ne chargeaient jamais `.env` — seul Next.js le fait. En production, le worker aurait démarré sans clé Anthropic, sans `APP_SECRET` (donc incapable de déchiffrer les tokens Outlook) et sans token WhatsApp. Chargement ajouté dans `src/lib/dotenv.ts`, appelé par `getEnv()`, sans écraser les variables déjà définies.
- Les erreurs techniques (SQLite, système de fichiers, exceptions JavaScript) remontaient jusqu'à l'interface ; elles sont remplacées par un message lisible, le détail restant dans les journaux.
- `APP_URL` en `http://` en production était accepté : le démarrage est désormais refusé (message explicite, `.env.example` commenté).
- **Perte de données possible** : `restore.sh` créait sa sauvegarde de sécurité dans `backups/` puis renommait la dernière archive ; quand l'archive à restaurer se trouvait dans ce dossier avec le même horodatage à la seconde près, elle était écrasée et la restauration échouait sans rien restaurer. L'archive source est désormais copiée avant toute écriture et la sauvegarde de sécurité est écrite sous un nom distinct (`pre-restore-*`), sans renommer aucune archive existante. Test de non-régression ajouté (cycle sauvegarde → restauration complet).
- La sauvegarde dépendait du binaire `sqlite3` et retombait sinon sur une copie non cohérente ; elle utilise l'API `backup` de better-sqlite3, vérifie l'intégrité et échoue proprement.

### Ajouté
- Validation de la configuration au démarrage (`checkEnv`, `assertEnvUsable`) : variable obligatoire manquante = démarrage refusé, message nommant la variable ; avertissements pour les intégrations optionnelles.
- En-têtes de sécurité : CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS en production, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Limitation des tentatives de connexion (8 par 10 minutes, blocage 15 minutes, en mémoire) ; connexions et échecs journalisés dans `history`.
- Droits resserrés automatiquement : `private/` et `data/` en 700, `.env` et base en 600 ; inspection des droits dans le diagnostic.
- Import et suppression de la signature et du tampon depuis Sociétés (`POST`/`DELETE /api/companies/[id]/assets`) : PNG vérifié (taille, magic bytes, IHDR, dimensions), nom généré par le serveur, stockage `private/`, jamais `public/`.
- Observabilité : `src/lib/diagnostics.ts`, `/api/health` (public minimal, détaillé authentifié, 503 si FAIL), page Paramètres → Diagnostic (contrôles, stockage, alerte disque) et Consommation Claude (par jour, par opération, coût estimé via `settings.costs`).
- `npm run doctor` : 14 contrôles PASS/WARN/FAIL (Node, `.env`, configuration, intégrité SQLite et migrations, worker, disque, droits, intégrations, sociétés, coûts), sans afficher aucun secret.
- Sauvegarde : métadonnées `backup.json` (version, date, hôte, compteurs), rétention configurable (7 par défaut), archives en 600, `.env` exclu ; restauration avec contrôle d'intégrité et migrations automatiques.
- Journaux : masquage des adresses email et des numéros, clés sensibles élargies (cookie, session, credential, chemins d'assets).
- Documentation : `docs/client-onboarding.md`, `docs/pilot-checklist.md`, `docs/privacy.md` (flux de données, export, suppression), `docs/e2e-report.md` (matrice PASS / NOT TESTED), `docs/deployment.md` complété (droits, diagnostic, supervision, rotation des journaux, rétention, vérification d'installation neuve).
- `ROADMAP.md` : section V2 des fonctionnalités reportées.
- 19 nouveaux tests (243 au total) : validation d'environnement, chargement `.env`, limitation de connexion, session et cookie falsifié, masquage des journaux, messages d'erreur, import d'asset, traversée de chemin, droits, diagnostic, coûts, en-têtes, sauvegarde.

### Vérifié
- Installation neuve complète dans un dossier vierge : `npm ci`, `.env`, migrations, `doctor`, `build`, démarrage, authentification, limitation de connexion, import de signature, traversée de chemin, sauvegarde et restauration réelles.
- Aucun secret dans l'historique git ; seuls `.env.example` et `private/.gitkeep` y figurent.

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
