# ROADMAP.md — Feuille de route EMA

Légende : ✅ terminé · 🔄 en cours · ⏳ à faire

## PHASE 0 — Structure + docs + interface de base ✅

- ✅ Documentation : CLAUDE.md, ARCHITECTURE.md, BUSINESS_RULES.md, TOOLS.md, SECURITY.md, ROADMAP.md, CHANGELOG.md, README.md, docs/deployment.md
- ✅ `.env.example`, `.gitignore`, `package.json`, configs TypeScript / ESLint / Vitest / Next
- ✅ Arborescence `src/` (agent, tools, integrations, actions, worker, database, security, lib), `config/`, `data/`, `private/`, `docs/`, `scripts/`, `tests/`
- ✅ Fichiers de configuration d'exemple : `config/*.example.json` + chargeur zod (`src/lib/config.ts`)
- ✅ SQLite : connexion, migrations, repositories (emails, actions, approvals, followups, documents, history, tokens, settings)
- ✅ Action Engine : types, niveaux de risque, transitions, exécution idempotente, tests
- ✅ Couche tools : `defineTool()`, registre, contrats zod de tous les tools (implémentations Outlook/WhatsApp/PDF en phases suivantes)
- ✅ Prompt agent `src/agent/ema.md`, schéma `EmailAnalysis`, squelette orchestrator/context
- ✅ Sécurité : `wrapUntrusted()`, chiffrement tokens, auth UI par mot de passe
- ✅ Interface : navigation (Aujourd'hui, Emails, À valider, Chat EMA, Documents, Relances, Historique, Règles, Sociétés, Paramètres) + `/setup` en 8 étapes + `/api/health` + `/api/status`
- ✅ Worker : boucle de scheduler + verrous (tâches réelles branchées en phases 1 et 6)
- ✅ Scripts `backup.sh` / `restore.sh`, `ecosystem.config.cjs` PM2
- ✅ `npm run check` (typecheck + lint + test + build) vert

## PHASE 1 — Outlook ✅

- ✅ OAuth Microsoft (authorization code, état anti-CSRF, refresh proactif et sur 401), stockage chiffré dans `oauth_tokens`
- ✅ Permissions minimales : `offline_access User.Read Mail.Read Mail.Send` (pas de Mail.ReadWrite)
- ✅ Client Graph centralisé : 401/429/5xx/réseau, pagination, erreurs assainies
- ✅ Synchronisation delta de la boîte de réception (curseur local, limite par passage, première synchro bornée), dédoublonnage par `graph_id`
- ✅ Threads via `conversationId` (messages importés en `CONTEXT`), recherche `$search`
- ✅ Pièces jointes : téléchargement dans `private/documents/yyyy/mm/`, refus des types dangereux et des fichiers trop gros, SHA-256, unicité
- ✅ Tools réels : `get_new_emails`, `get_email`, `get_email_thread`, `search_emails`, `get_attachment`
- ✅ Exécuteurs Outlook `reply_email` / `forward_email` / `send_email` (+ emails internes de paiement) : envoi uniquement via l'Action Engine après validation
- ✅ Worker : `scan_mailbox` réel ; routes `/api/integrations/microsoft/*` ; panneau Outlook (Setup + Paramètres), bouton Synchroniser (Emails)
- ✅ 28 tests Microsoft/Outlook avec Graph mocké, `docs/outlook.md`

## PHASE 2 — Claude + compréhension email ✅

- ✅ Intégration Anthropic réelle (`src/integrations/anthropic/structured.ts`) : sortie structurée zod, timeout, retries SDK limités, erreurs typées (`LlmError`), journal `llm_runs` (tokens, durée, erreur) sans contenu ni clé
- ✅ Context Engine borné : email, thread (statut `CONTEXT` inclus), sociétés, contacts, règles présélectionnées, pièces jointes (métadonnées), analyses précédentes ; séparation explicite fiable / non fiable
- ✅ Schéma d'analyse strict (12 catégories, urgence, montant, échéance, needs_reply, recommended_action, confiance, requires_human_review, reply_draft, reasoning_summary, injection_suspected)
- ✅ Garde-fous anti-hallucination : société vérifiée en code, seuils de confiance configurables, actions sensibles toujours revues, injection neutralisée (heuristique + modèle)
- ✅ Moteur de règles déterministe (`config/rules.json`) : destinataire de transfert issu de la configuration, jamais du modèle
- ✅ Worker : `scan_mailbox` → analyse des nouveaux emails, `analyze_emails` de rattrapage, statuts NEW/ANALYZING/ANALYZED/ANALYSIS_FAILED, jamais de relance automatique après échec, analyses bloquées libérées
- ✅ Brouillon de réponse matérialisé par une action `prepare_reply` (LOW, sans effet) — aucun email envoyé
- ✅ Réanalyse manuelle (`POST /api/emails/{id}/analyze`, boutons UI)
- ✅ Interface : Emails (résumé, catégorie, urgence, société, actions, confiance, validation humaine, brouillon), détail d'email, Aujourd'hui, Paramètres (seuils)
- ✅ Chat EMA lecture seule (Claude + outils de lecture, boucle bornée)
- ✅ Migration `003_analysis`, 28 nouveaux tests (Anthropic mocké, injection testée), `docs/analysis.md`

## PHASE 3 — WhatsApp + validation ✅

- ✅ Client WhatsApp Business Cloud API centralisé (`src/integrations/whatsapp/client.ts`) : token jamais exposé, retries bornés 429/5xx, erreurs Meta explicites
- ✅ Message de validation compact avec boutons interactifs ✅ Valider / ❌ Refuser (`approve:<approval_id>` / `reject:<approval_id>`), texte long séparé si nécessaire
- ✅ Webhook `/api/integrations/whatsapp/webhook` : vérification `hub.verify_token`, signature `X-Hub-Signature-256` (obligatoire en production), JSON validé, dédoublonnage `webhook_events`
- ✅ Numéro autorisé `WHATSAPP_APPROVER_PHONE` : seul décideur, tout autre numéro ignoré
- ✅ Approvals réutilisées (usage unique, expiration, une seule notification active, renvoi après expiration, relance par le worker si WhatsApp indisponible)
- ✅ Analyse → action `reply_email` en `WAITING_APPROVAL` (jamais exécutée sans validation), réanalyse sans doublon
- ✅ Valider → Action Engine (`APPROVED → EXECUTING` atomique) → exécuteur Outlook → réponse réelle dans le thread → `COMPLETED` ; Refuser → `REJECTED`, aucun envoi
- ✅ Échec Graph après validation → `FAILED`, email non considéré envoyé, « Réessayer l'envoi »
- ✅ Page À valider : expéditeur, objet, résumé, société, confiance, brouillon éditable (Modifier), Valider et envoyer, Refuser, Renvoyer la demande, statuts En attente / Validé / Envoyé / Refusé / Expiré / Échec
- ✅ Setup / Paramètres : panneau WhatsApp (connecté, numéro masqué, webhook, Test notification réel)
- ✅ Historique complet (analyse, brouillon, action, demande envoyée, décision, exécution, erreurs)
- ✅ 18 nouveaux tests (WhatsApp et Graph mockés : double clic, rejeu, UI + WhatsApp simultanés, Graph en échec, brouillon modifié, mauvais numéro, expiration…), `docs/whatsapp.md`
- ✅ **Scénario n°1 complet** : email → sync → analyse → brouillon → WhatsApp → validation → réponse Outlook → historique (validé avec Graph et WhatsApp simulés ; test réel à faire avec les credentials du client)

## PHASE 4 — Factures + paiements ✅

- ✅ Document Engine (`src/documents/`) : extraction de texte PDF (pdf-parse v2, MIME/taille/signature vérifiés, PDF scanné détecté sans OCR), classification stricte (9 types), schéma d'extraction zod, garde-fous déterministes (cohérence HT/TVA/TTC, société vérifiée, IBAN, changement de RIB), doublons prudents
- ✅ Routage déterministe : `forward_email` selon `config/rules.json`, `payment_request` / `deposit_request` (send_email interne, HIGH) vers le contact comptable configuré ; aucune adresse issue du modèle ; blocage sur injection, changement de RIB, doublon, absence de règle
- ✅ Intégration Action Engine + WhatsApp (messages 📄 facture / 💳 paiement avec la note « aucun paiement bancaire »), exécuteurs Outlook réutilisés (forward avec pièces jointes, sendMail)
- ✅ Worker : analyse documentaire déclenchée par l'analyse email, tâche de rattrapage `analyze_documents`
- ✅ Tools réels : `extract_pdf_text`, `classify_document`, `extract_invoice_data`, `extract_quote_data`, `search_documents`, `get_document`, `list_pending_actions` ; chat lecture seule sans action bancaire
- ✅ Interface : Documents (onglets, recherche, doublons, RIB, PDF sans texte), détail d'un document, pièces jointes analysées dans le détail d'un email, compteurs Aujourd'hui, détails facture dans À valider
- ✅ Migration `005_documents`, 22 nouveaux tests avec fixtures PDF (pdf-lib) et intégrations mockées, `docs/documents.md`

## PHASE 5 — Devis + signature graphique / tampon ✅

- ✅ Schéma QUOTE étendu (référence, validité, objet, montants, acompte, conditions, `signature_requested`), garde-fous déterministes (expiration `QUOTE_EXPIRED`, montants, société inconnue/ambiguë, RIB, contrat → manuel)
- ✅ `config/companies.json` : `legalName`, `email`, `quoteApprovalText`, `stampRequired`, `signaturePlacement` ; assets PNG vérifiés dans `private/signatures` et `private/stamps` (`src/documents/assets.ts`)
- ✅ Service `src/documents/sign.ts` : `checkSignatureReadiness`, `prepareQuoteSignature` (action `sign_document` CRITICAL, idempotente), `createSignedCopy` (idempotente, empreinte vérifiée, nouveau fichier `private/signed-documents/<yyyy>/<mm>/`, ligne `documents` chaînée)
- ✅ `src/documents/sign-pdf.ts` (pdf-lib) : `APPEND_APPROVAL_PAGE` par défaut, `OVERLAY_LAST_PAGE` avec coordonnées configurées ; PDF chiffré/corrompu refusé
- ✅ Exécuteur `sign_document` : réponse dans le thread avec le seul PDF signé, statuts `signed` → `signed_and_sent`, retry sans second PDF
- ✅ Un seul tool `prepare_signed_document` (analyse + chat) ; `apply_signature` / `apply_stamp` supprimés (fonctions internes)
- ✅ WhatsApp « 📄 EMA — Devis à signer » (étapes ✓, avertissements, note signature réelle) ; UI À valider (aperçu devis, « Valider et signer », « ✅ Devis signé »), Documents (statuts, onglet Devis signés, validité), détail (chaîne original → signé), éditeur Sociétés
- ✅ Migration `006_signatures`, `docs/signatures.md`, 19 tests
- ⏳ Reporté : upload de signature/tampon depuis l'interface (dépôt manuel dans `private/` pour l'instant)

## PHASE 6 — Pilotage complet d'EMA depuis WhatsApp ✅

- ✅ WhatsApp Router (`src/integrations/whatsapp/router.ts`) : numéro autorisé → assistant activé → dédoublonnage Meta → boutons (service d'approbations phase 3) ou texte (assistant). Webhook, client et approbations réutilisés tels quels.
- ✅ Assistant conversationnel (`src/agent/whatsapp-assistant.ts`) réutilisant le Chat EMA : lecture / préparation / action, sans commandes à retenir
- ✅ Outils explicites : lecture (emails, documents, contacts, sociétés, actions, point du jour) et préparation (`reply_email`, `send_email`, `forward_email`, `prepare_document_forward`, `prepare_payment_request`, `prepare_deposit_request`, `prepare_signed_document`, `update_draft`) — chacun crée une action soumise à validation
- ✅ Nouveaux tools `search_contacts`, `get_company`, `get_today_summary`, `update_draft`, `prepare_document_forward`
- ✅ Mémoire multi-tours dans `chat_messages` (migration `007_whatsapp_chat` : canal, identifiant Meta, expéditeur masqué, références numérotées) — « le premier », « le deuxième », « réponds-lui »
- ✅ Validation en langage naturel déterministe (« valide », « annule ») avec désambiguïsation quand plusieurs actions sont en attente ; boutons inchangés
- ✅ Modification d'un brouillon depuis WhatsApp (`update_draft` → `editActionPayload`, tracée dans `history`)
- ✅ `WHATSAPP_ASSISTANT_ENABLED` + panneau Paramètres → WhatsApp ; `docs/whatsapp-assistant.md` ; 31 tests
- ⏳ Reporté : réception de pièces jointes envoyées par WhatsApp, notifications spontanées

## PHASE 7 — Relances intelligentes ✅

- ✅ `scheduled_followups` étendu (migration `008_followups`) : type de suivi, ancrage `watch_after`, société/document, action générée, notifications, diagnostic ; machine d'état complète (13 statuts, transitions atomiques)
- ✅ Échéances calculées côté serveur (`src/followups/schedule.ts`) : « dans 3 jours », « vendredi », « le 22 septembre », heure par défaut, jours ouvrés — le modèle n'exprime qu'une intention
- ✅ Vérification Microsoft Graph obligatoire à l'échéance ; détection déterministe réponse humaine / automatique / ambiguë (`detect.ts`) ; message sortant plus récent → relance obsolète
- ✅ Brouillon contextualisé (sortie structurée, ton adapté à la tentative) → action `reply_email` dans le thread → validation WhatsApp obligatoire → envoi par l'Action Engine → `SENT` (nouvel ancrage, tentative +1)
- ✅ Report, annulation, `maxAttempts`, rappels internes (`INTERNAL_REMINDER` + boutons WhatsApp Terminé / Reporter)
- ✅ Notifications proactives : dédoublonnées, template Meta hors fenêtre de 24 h, jamais « envoyées » si Meta refuse
- ✅ Tools `list_followups`, `postpone_followup`, `prepare_followup_now`, `complete_reminder` ; pilotage WhatsApp avec références multi-tours
- ✅ Page Relances complète (À traiter, À valider, Aujourd'hui, À venir, Envoyées, Annulées) et compteurs sur Aujourd'hui
- ✅ Worker sous verrou, reprise après interruption, `docs/followups.md`, 34 tests
- ⏳ Reporté : jours fériés, relances récurrentes automatiques après envoi

## PHASE 8 — Production ready ✅

- ✅ Validation de la configuration au démarrage : une variable obligatoire manquante empêche le démarrage (message nommant la variable) ; `.env` désormais chargé par le worker et les scripts (bug bloquant corrigé)
- ✅ Sécurité HTTP : CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy ; limitation des tentatives de connexion (8 par 10 min, blocage 15 min) ; journal d'authentification
- ✅ Droits des fichiers resserrés automatiquement (`private/` et `data/` en 700, `.env` et base en 600) et vérifiés par le diagnostic
- ✅ Import de signature et de tampon depuis l'interface (PNG vérifié, nom généré par le serveur, stockage `private/`, suppression possible)
- ✅ Observabilité : `/api/health` (public minimal, détaillé authentifié, 503 si FAIL), page Paramètres → Diagnostic, alerte disque, consommation Claude par jour et coût estimé
- ✅ `npm run doctor` : 14 contrôles PASS/WARN/FAIL sans afficher de secret
- ✅ Sauvegarde cohérente (better-sqlite3, `integrity_check`), métadonnées `backup.json`, rétention 7, restauration testée en conditions réelles
- ✅ Journaux : tokens, mots de passe et chemins d'assets masqués ; adresses email et numéros masqués ; erreurs techniques remplacées par un message lisible
- ✅ Documentation : déploiement complet, `client-onboarding.md`, `pilot-checklist.md`, `privacy.md`, `e2e-report.md`
- ✅ Installation neuve validée (clone, `npm ci`, migrations, doctor, build, démarrage, sécurité, import, sauvegarde/restauration) ; 243 tests
- ⏳ Reporté : tests E2E avec credentials réels (Microsoft, Anthropic, Meta) et VPS — à cocher à la mise en service (`docs/e2e-report.md`)

## PHASE 8A — Durcissement production ✅

Aucune nouvelle fonctionnalité métier : fiabilité, idempotence, reprise après interruption, surface d'attaque.

- ✅ Restitution des documents : PDF en ligne uniquement, HTML/SVG/XML/`.eml` neutralisés (`octet-stream`, `attachment`, `nosniff`, CSP `sandbox`) — plus aucun contenu reçu par email ne peut s'exécuter dans l'origine EMA
- ✅ Envois Microsoft jamais rejoués à l'aveugle : `DELIVERY_AMBIGUOUS` sur coupure réseau ou 5xx, seuls 401 et 429 rejoués
- ✅ Réconciliation avec les éléments envoyés avant toute nouvelle tentative (`sent` / `not_sent` / `unknown`) ; dans le doute, vérification humaine, jamais de second envoi
- ✅ Verrous worker : propriétaire unique par exécution, aucun verrou actif repris ; `renewLock` / `releaseLock`
- ✅ Événements entrants : cycle `RECEIVED → PROCESSING → PROCESSED | FAILED`, reprise après crash, jamais de seconde action pour un message interrompu
- ✅ Destinataires déterministes : `contact_id` côté modèle, `validateOutboundRecipients()` avant chaque envoi
- ✅ Reprise des actions interrompues (tâche worker) ; un devis déjà signé n'est jamais re-signé
- ✅ Connexion : 5 tentatives / 15 min persistées en SQLite, `X-Forwarded-For` ignoré sauf `TRUST_PROXY_HEADER=true`
- ✅ Sauvegardes chiffrées AES-256-GCM (scrypt), refusées en clair en production ; restauration déchiffrée en dossier temporaire
- ✅ Pièces jointes sortantes limitées (`OUTGOING_ATTACHMENT_MAX_MB`) avant tout appel Graph ; extraction PDF dans un *worker thread* réellement arrêtable
- ✅ Intégration continue GitHub (Node 22, `npm run check`, `npm audit --omit=dev` sur vulnérabilités hautes/critiques runtime)
- ✅ 45 tests de durcissement dédiés (289 tests au total), aucun envoi réel, aucune donnée client, aucun secret réel
- ⛔ **Blocage de livraison** : le dépôt GitHub `madjid90/Agent-email-ema-` doit être **passé en privé manuellement** avant tout déploiement commercial (Settings → General → Danger Zone → Change repository visibility). Action humaine : aucun code ne modifie la visibilité du dépôt.

## PHASE 8A.1 — Corrections finales avant VPS ✅

- ✅ Worker démarré par `bootstrap()` (mêmes contrôles que le web, sans double enregistrement) ; démarrage refusé en production si la configuration est bloquante
- ✅ Restauration : sauvegarde de sécurité pré-restauration obligatoire ; en cas d'échec, arrêt avant toute modification (`--force-without-safety-backup` en dernier recours)
- ✅ Adresse client : `X-Forwarded-For` jamais lu ; `X-Real-IP` seulement si `TRUST_PROXY_HEADER=true`, avec la configuration Nginx correspondante documentée
- ✅ Réconciliation renforcée : conversation + destinataire / contenu / pièce jointe signée selon le type d'action ; correspondance partielle → `unknown`
- ✅ `APP_PASSWORD` < 12 caractères : erreur bloquante en production
- ✅ `stop()` de l'ordonnanceur annule aussi le premier tick différé
- ✅ 11 tests supplémentaires (300 au total)

## V2 — fonctionnalités reportées (hors périmètre V1)

Aucune de ces fonctionnalités n'est nécessaire au premier pilote. Elles sont listées ici pour éviter qu'elles ne s'invitent dans la V1.

- **Documents** : OCR des PDF scannés, réception de pièces jointes par WhatsApp, upload de documents depuis l'interface.
- **WhatsApp** : messages vocaux, notifications spontanées au-delà des relances, plusieurs numéros autorisés.
- **Relances** : jours fériés, relances récurrentes automatiques, règles de relance par catégorie.
- **Signature** : signature électronique qualifiée (eIDAS), signature de contrats, positionnement assisté.
- **Recherche** : index vectoriel / RAG sur l'historique.
- **Agenda** : lecture et création d'événements.
- **Exploitation** : interface d'administration multi-instances, supervision centralisée, mises à jour automatiques.
- **Sécurité** : second facteur, plusieurs utilisateurs, journal d'audit exportable.

