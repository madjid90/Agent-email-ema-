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

## PHASE 3 — WhatsApp + validation ⏳

- Envoi de messages interactifs (VALIDER / REFUSER / MODIFIER)
- Webhook (vérification, signature, idempotence)
- Exécution après validation, expiration
- Page À valider synchronisée
- **Scénario n°1 complet et fiable** : email reçu → analyse → réponse proposée → WhatsApp → validation → réponse dans Outlook

## PHASE 4 — Factures + paiements ⏳

- Extraction PDF (texte + données facture)
- Moteur de règles (`config/rules.json`) → transfert au bon contact
- `prepare_payment_request` / `prepare_deposit_request`
- Page Documents (Factures)

## PHASE 5 — Devis + signature / tampon ⏳

- Extraction devis, détection société
- Workflow signature (copie, « Bon pour accord », date, signature, tampon) avec `pdf-lib`
- Retour du PDF signé dans le thread + archivage
- Upload signature/tampon dans le setup

## PHASE 6 — Relances ⏳

- `scheduled_followups` complet : programmation, vérification de réponse, relance proposée, validation, envoi
- Page Relances (Annuler / Reporter / Exécuter maintenant)

## PHASE 7 — VPS ⏳

- Procédure de déploiement validée sur Ubuntu (PM2, Nginx, SSL)
- Sauvegarde / restauration testées
- Procédure de mise à jour
- Durcissement (rate limiting, rotation des logs)
