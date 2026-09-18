# POC — Outlook via Composio (lecture seule)

Test technique : Composio peut-il remplacer / simplifier la connexion Outlook d'EMA ? Ce POC est **isolé** : l'intégration Microsoft Graph existante reste celle utilisée par le worker, les tools et l'Action Engine. Il est **désactivé par défaut**.

## Activation

```
COMPOSIO_POC_ENABLED=true
COMPOSIO_API_KEY=<clé du projet Composio, .env uniquement>
COMPOSIO_OUTLOOK_AUTH_CONFIG_ID=<facultatif si une seule auth config Outlook>
```

- `COMPOSIO_POC_ENABLED=false` (défaut) : les routes `/api/poc/composio/*` répondent 404, la page `/poc/composio` n'existe pas, EMA fonctionne exactement comme avant.
- La clé ne quitte jamais le serveur : jamais dans Git, le frontend, les journaux, une réponse API ni un test (les tests utilisent une clé factice et un faux serveur Composio).

## Choix technique : REST plutôt que SDK

`@composio/core` 0.18 exige **Node ≥ 22.22.3** (EMA : `engines >= 20.11`, VPS en 22.22.2) et dépend d'`openai`, `pusher-js`, `undici`. Conformément à la consigne, EMA n'est pas mis à niveau pour un POC : `src/integrations/composio/client.ts` appelle l'**API REST v3.1** (`https://api.composio.dev/api/v3.1`, en-tête `x-api-key`), contrat lu dans le client généré officiel `@composio/client` publié sur npm (la documentation `docs.composio.dev` n'est pas joignable depuis l'environnement de développement) :

| Besoin | Endpoint |
|---|---|
| Auth configs Outlook | `GET /auth_configs?toolkit_slug=outlook` |
| Démarrer l'OAuth pour un utilisateur | `POST /connected_accounts/link` `{ auth_config_id, user_id, callback_url }` → `{ connected_account_id, redirect_url }` |
| Statut d'un compte | `GET /connected_accounts/{id}` (`INITIATED`, `ACTIVE`, `FAILED`, `EXPIRED`, `INACTIVE`, `REVOKED`, `status_reason`, `requested_scopes`) |
| Déconnexion + révocation | `DELETE /connected_accounts/{id}?revoke_on_delete=true` |
| Tools du toolkit | `GET /tools?toolkit_slug=outlook` |
| Exécution | `POST /tools/execute/{slug}` `{ connected_account_id, user_id, arguments }` → `{ successful, data, error }` |

⚠️ `GET /connected_accounts/{id}` renvoie l'état complet, **access token Microsoft compris** (`state.val.access_token`). Le client assainit la réponse (`sanitizeAccount`) : ce champ n'est jamais lu, stocké, renvoyé ni journalisé. La table `composio_connections` ne contient que des références (`connected_account_id`, `auth_config_id`, statut, adresse, scopes demandés).

## Architecture

```
Paramètres → Connexions → « Outlook via Composio (POC) » → /poc/composio
  [Connecter] → POST /api/poc/composio/connect → link Composio (user_id = user.id EMA) → redirect Microsoft
  ← callback Composio → GET /api/poc/composio/callback → statut relu chez Composio → /poc/composio
  [Tester la connexion] → GET status?refresh=1      [Déconnecter] → POST disconnect (revoke_on_delete)
  Zone de test → POST /api/poc/composio/read { operation } → resolveOperation + assertReadOnlySlug → execute
```

- `src/integrations/composio/client.ts` — client REST assaini.
- `src/integrations/composio/policy.ts` — politique **fail-closed** : un tool n'est exécutable que s'il appartient au toolkit `outlook`, n'est pas déprécié, contient un verbe de lecture et **aucun** verbe d'écriture (`SEND|REPLY|FORWARD|DELETE|MOVE|CREATE|UPDATE|MARK|…`). Les opérations exposées sont fixes (`list_recent`, `search`, `get_message`, `list_attachments`, `get_attachment`, `list_events`, `get_profile`) ; le client n'envoie jamais un slug, seulement une opération.
- `src/integrations/composio/outlook-poc.ts` — service : connexion / statut / déconnexion **par utilisateur** (identifiant externe = `user.id`, stable ; toute exécution exige `connected_account_id` + `user_id` ; une référence pointant vers le compte d'un autre utilisateur est rejetée et supprimée), lectures avec adaptation des arguments aux paramètres déclarés par le tool, contenu binaire des pièces jointes jamais renvoyé.
- Migration `011_composio_poc` (table `composio_connections`), routes `src/app/api/poc/composio/*`, page `src/app/(app)/poc/composio`, composant `composio-poc-panel.tsx`.

Les **slugs des tools Outlook** n'ont pas pu être vérifiés hors ligne : ils sont résolus à l'exécution contre la liste réelle du toolkit (`OPERATION_CANDIDATES`), et le bouton « Tools disponibles (diagnostic) » affiche les slugs autorisés / refusés réellement renvoyés par Composio. Si une opération ne trouve aucun tool de lecture, l'erreur liste les slugs disponibles : ajuster alors `OPERATION_CANDIDATES` (aucun tool d'écriture ne peut être choisi, quelle que soit la liste).

## Auth config Composio (à faire dans le tableau de bord)

1. Composio → Auth Configs → **Outlook** → créer une auth config. Préférer une **auth config personnalisée** (votre propre App Registration Entra) afin de fixer des scopes **lecture seule** : `offline_access User.Read Mail.Read Calendars.Read` (+ `openid profile`). L'auth config gérée par Composio peut demander des scopes d'écriture (`Mail.ReadWrite`, `Mail.Send`) : le POC les refuse à l'exécution mais les affiche en alerte.
2. Redirect URI Entra : celle indiquée par Composio pour l'auth config (l'OAuth est hébergé par Composio ; EMA ne reçoit que le retour `callback_url`).
3. Copier l'identifiant de l'auth config dans `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` (facultatif s'il n'y en a qu'une).
4. Si le tenant Microsoft 3T exige l'approbation d'un administrateur, Microsoft affiche « Need admin approval » et Composio marque le compte `FAILED` : EMA affiche **« Microsoft administrator approval required. »** et ne contourne rien. Un administrateur du tenant doit approuver l'application (Entra → Enterprise applications → Admin consent).

## Smoke test réel (compte Outlook professionnel 3T)

Prérequis : `npm run db:migrate`, `.env` avec les trois variables, EMA démarré (`npm run dev` ou PM2), compte EMA créé et connecté.

| # | Test | Action | Attendu |
|---|---|---|---|
| 1 | Connexion Outlook 3T | Paramètres → Connexions → « Ouvrir le POC » → **Connecter Outlook via Composio** → connexion Microsoft 3T → consentement → retour EMA | État **Connecté**, adresse du compte affichée (tool de profil) ; sinon « adresse non déterminée » + diagnostic des tools |
| 2 | 5 derniers emails | **5 derniers emails** | JSON des 5 messages les plus récents de la boîte 3T, nom du tool utilisé |
| 3 | Recherche | saisir un mot (ex. objet connu) → **Rechercher** | résultats correspondants |
| 4 | Métadonnées d'un email | coller un `id` issu de 2 ou 3 → **Détails** | objet, expéditeur, dates, corps |
| 5 | Pièce jointe | **Pièces jointes** puis coller un id de pièce jointe → **Récupérer** | métadonnées (nom, taille, type) ; le contenu binaire est remplacé par « contenu binaire de N caractères non affiché » |
| 6 | Calendrier | **Calendrier** | événements des 14 prochains jours |
| 7 | Aucune écriture | **Tools disponibles (diagnostic)** | tous les tools SEND / REPLY / FORWARD / DELETE / MOVE / MARK / CREATE / UPDATE / UPLOAD apparaissent dans « refusés » ; aucun bouton d'écriture n'existe ; `curl -X POST /api/poc/composio/read -d '{"operation":"send_email"}'` → 400 |
| 8 | Déconnexion | **Déconnecter** | état **Déconnecté**, compte supprimé et révoqué chez Composio (`revoke_on_delete=true`) |
| 9 | Reconnexion | **Connecter Outlook via Composio** à nouveau | nouveau compte connecté, état **Connecté** |

Contrôles transverses : `grep -r "<clé>" logs/` ne renvoie rien ; `sqlite3 data/ema.db "select * from composio_connections"` ne contient aucun token ; un second compte EMA (autre navigateur) voit **Déconnecté** et ne peut rien lire (isolation).

## Limites du POC

- Slugs Outlook et noms de paramètres résolus dynamiquement (documentation Composio inaccessible hors ligne) : à confirmer au smoke test via le diagnostic.
- Lecture seule ; aucune intégration au worker, aux tools Claude, à l'Action Engine ni à WhatsApp.
- L'adresse du compte dépend d'un tool de profil Outlook côté Composio ; à défaut, l'état reste « Connecté » sans adresse.
- Les scopes OAuth réels dépendent de l'auth config Composio (à restreindre côté Composio / Entra) ; le code ne peut que les afficher et refuser les écritures à l'exécution.
