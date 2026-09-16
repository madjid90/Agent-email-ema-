# Rapport de tests de bout en bout — EMA V1

Date : 16/09/2026 · Version : 1.0.0 · Environnement de vérification : machine de développement Linux, installation neuve (`/tmp/ema-clean`), Node 22.22.

**Règle de lecture.** `PASS` signifie que le test a réellement été exécuté et observé. `NOT TESTED` signifie qu'il n'a pas pu l'être faute de credentials réels (Microsoft, Anthropic, Meta) ou de VPS : ces lignes restent à cocher par l'intégrateur lors de la mise en service, avec `docs/pilot-checklist.md`. Aucune ligne n'est marquée `PASS` sur la foi d'un test simulé quand la spécification demande un test réel.

## 1. Matrice

| Test | Résultat | Méthode |
|---|---|---|
| Outlook OAuth | **NOT TESTED** | nécessite une App Registration Microsoft réelle |
| Outlook sync (delta, threads, pièces jointes) | **NOT TESTED** (réel) · PASS en simulation | 30 tests avec Graph simulé (`tests/microsoft-*.test.ts`) |
| Outlook token expiré / reconnexion | **NOT TESTED** (réel) · PASS en simulation | rafraîchissement 401 et backoff testés avec un faux Graph |
| Anthropic analysis | **NOT TESTED** (réel) · PASS en simulation | analyses email et document avec client Anthropic simulé |
| Anthropic latence / coût | **NOT TESTED** | compteur local prêt (Paramètres → Consommation Claude, `npm run doctor`) |
| WhatsApp text (message entrant) | **NOT TESTED** (réel) · PASS en simulation | webhook signé simulé, 31 tests assistant |
| WhatsApp approval (boutons) | **NOT TESTED** (réel) · PASS en simulation | boutons `approve:`/`reject:` simulés de bout en bout |
| WhatsApp template hors fenêtre 24 h | **NOT TESTED** (réel) · PASS en simulation | erreur Meta 131047 simulée → bascule template ou notification différée |
| Email reply | **NOT TESTED** (réel) · PASS en simulation | `reply_email` → Graph simulé, un seul appel |
| Email send | **NOT TESTED** (réel) · PASS en simulation | `send_email` via Action Engine |
| Email forward | **NOT TESTED** (réel) · PASS en simulation | `forward_email`, destinataire issu des règles |
| Invoice PDF (extraction, routage) | **NOT TESTED** (réel) · PASS en simulation | PDF générés, extraction pdf-parse réelle, Claude simulé |
| Quote signing (CRITICAL) | **NOT TESTED** (réel) · PASS en simulation | PDF signé réellement produit par pdf-lib et relu |
| Signed PDF return | **NOT TESTED** (réel) · PASS en simulation | pièce jointe unique vérifiée octet par octet |
| Followup no reply | **NOT TESTED** (réel) · PASS en simulation | échéance + thread simulé sans réponse → brouillon validé |
| Followup reply received | **NOT TESTED** (réel) · PASS en simulation | réponse humaine détectée → relance annulée |
| Followup Graph indisponible | PASS | Graph en erreur 503 et Outlook déconnecté → `CHECK_FAILED`, aucune action, aucun email (test automatisé + serveur réel) |
| Clean install | **PASS** | `npm ci`, `.env`, `db:migrate`, `doctor`, `build`, `start` dans un dossier neuf |
| Migrations | **PASS** | 8 migrations appliquées sur une base vide, `integrity_check = ok` |
| Production build | **PASS** | `npm run build` sur installation neuve |
| Health endpoint | **PASS** | public minimal + détaillé authentifié, 503 si FAIL |
| `npm run doctor` | **PASS** | 14 contrôles, PASS/WARN/FAIL, aucun secret affiché |
| Backup | **PASS** | archive + `backup.json` (compteurs), copie cohérente better-sqlite3, rétention 7 |
| Restore | **PASS** | données effacées puis restaurées : emails, documents, signatures, config, `integrity_check = ok` |
| Restart (idempotence) | **PASS** | redémarrage serveur avec action en attente : aucune double exécution (+ tests reprise worker) |
| Concurrence | **PASS** en simulation | double webhook, double validation, deux cycles worker simultanés (tests automatisés, SQLite réelle) |
| Security — authentification | **PASS** | `/setup` sans session → 307, API → 401, cookie falsifié refusé |
| Security — limitation de connexion | **PASS** | 8 essais puis 403 pendant 15 min (serveur réel) |
| Security — en-têtes HTTP | **PASS** | CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |
| Security — traversée de chemin | **PASS** | `../../.env` et `/etc/passwd` → 403 sur la route de fichiers |
| Security — import signature | **PASS** | PNG validé, nom généré, `private/` en 600 ; SVG refusé ; sans session → 401 |
| Security — secrets dans git | **PASS** | aucun secret dans les 9 commits ; seuls `.env.example` et `private/.gitkeep` versionnés |
| Security — journaux | **PASS** | tokens masqués, emails et numéros masqués (tests + inspection des journaux serveur) |
| PM2 (web + worker) | **NOT TESTED** | nécessite un VPS ; configuration fournie et documentée |
| Nginx + HTTPS | **NOT TESTED** | nécessite un domaine ; configuration fournie et documentée |

## 2. Couverture automatisée

243 tests (`npm run check` vert) : base de données, Action Engine, configuration, sécurité, tools, contexte, Graph (client, OAuth, synchronisation, exécuteurs), analyse, règles, chat, WhatsApp, documents, signature, assistant WhatsApp, relances, production.

Aucun test n'utilise de credentials réels : Microsoft, Anthropic et WhatsApp sont simulés ; les PDF et les PNG sont générés en mémoire.

## 3. À faire lors de la mise en service (lignes NOT TESTED)

1. App Registration Microsoft → OAuth, synchronisation, réponse, transfert, envoi, pièce jointe, token expiré, redémarrage avec token existant.
2. Clé Anthropic réelle → email simple, email long, thread, facture, devis, chat WhatsApp ; relever latence et tokens (Paramètres → Consommation Claude).
3. Numéro WhatsApp Business de test → message entrant, validation, refus, « valide » en langage naturel, message rejoué, mauvais numéro, expiration, notification proactive, template hors fenêtre.
4. Parcours complets email / facture / devis / relance avec la signature **de test**.
5. VPS : PM2, Nginx, HTTPS, sauvegarde planifiée, redémarrage machine.

Reporter les résultats dans ce tableau, en datant chaque ligne.
