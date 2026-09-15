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

## PHASE 1 — Outlook ⏳

- OAuth Microsoft (connect / callback / refresh), stockage chiffré
- Client Graph : `get_new_emails`, `get_email`, `get_email_thread`, `search_emails`, `get_attachment`, `reply_email`, `forward_email`, `send_email`
- Worker : scan périodique, dédoublonnage, téléchargement des pièces jointes
- Page Emails alimentée par la base
- Étape Outlook du setup fonctionnelle (« Outlook connecté », adresse, permissions)

## PHASE 2 — Claude + compréhension email ⏳

- Context builder (thread, historique pertinent, règles, sociétés)
- Orchestrator avec structured outputs → `EmailAnalysis`
- Préparation de réponse (brouillon) → action `reply_email` PROPOSED
- Page Aujourd'hui + Emails avec résumé, catégorie, confiance
- Chat EMA (mode `chat`, tools de lecture)

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
