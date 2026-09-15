# CHANGELOG

Toutes les modifications notables d'EMA sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).

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
