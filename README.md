# EMA — Agent administratif email (instance privée)

EMA est un agent administratif IA qui gère **une seule boîte Outlook professionnelle**, installé sur **le VPS du client**. Il lit les emails, comprend le contexte, propose des actions (réponse, transfert de facture, demande de paiement, signature de devis, relance), demande **validation sur WhatsApp**, puis exécute.

Aucune donnée ne quitte le VPS du client (hors appels API Microsoft Graph, Anthropic et WhatsApp nécessaires au fonctionnement).

## Stack

Next.js 15 · TypeScript · Claude (Anthropic API, tool calling) · Microsoft Graph · WhatsApp Business Cloud API · SQLite · Worker Node · PM2 · Nginx

## Démarrage rapide (développement)

```bash
cp .env.example .env          # renseigner les valeurs
npm install
npm run db:migrate
npm run dev                   # http://localhost:3000/setup
npm run worker                # dans un second terminal
```

Au premier démarrage, `config/*.json` est créé à partir de `config/*.example.json` s'il n'existe pas.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | Next.js en développement |
| `npm run worker` | Worker / scheduler |
| `npm run build` / `npm run start` | Production |
| `npm run lint` / `npm run typecheck` / `npm run test` | Qualité |
| `npm run check` | Tout enchaîner (obligatoire avant de clore une phase) |
| `npm run db:migrate` / `npm run db:status` | Migrations SQLite |

## Documentation

- [CLAUDE.md](CLAUDE.md) — source de vérité (règles, conventions, interdits)
- [ARCHITECTURE.md](ARCHITECTURE.md) — architecture détaillée
- [BUSINESS_RULES.md](BUSINESS_RULES.md) — règles métier
- [TOOLS.md](TOOLS.md) — couche de tools
- [SECURITY.md](SECURITY.md) — sécurité
- [ROADMAP.md](ROADMAP.md) — phases
- [CHANGELOG.md](CHANGELOG.md) — historique
- [docs/deployment.md](docs/deployment.md) — déploiement VPS
- [docs/outlook.md](docs/outlook.md) — Outlook / Microsoft Graph
- [docs/analysis.md](docs/analysis.md) — analyse des emails par Claude
- [docs/whatsapp.md](docs/whatsapp.md) — validation WhatsApp

## Licence

Usage privé, une instance par client.
