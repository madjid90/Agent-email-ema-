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

## PHASE 6 — Relances ⏳

- `scheduled_followups` complet : programmation, vérification de réponse, relance proposée, validation, envoi
- Page Relances (Annuler / Reporter / Exécuter maintenant)

## PHASE 7 — VPS ⏳

- Procédure de déploiement validée sur Ubuntu (PM2, Nginx, SSL)
- Sauvegarde / restauration testées
- Procédure de mise à jour
- Durcissement (rate limiting, rotation des logs)
