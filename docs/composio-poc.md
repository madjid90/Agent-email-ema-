# POC — Outlook via Composio (lecture seule)

Test technique : Composio peut-il remplacer / simplifier la connexion Outlook d'EMA ? Ce POC est **isolé** : l'intégration Microsoft Graph existante reste celle utilisée par le worker, les tools et l'Action Engine. Il est **désactivé par défaut**.

## Activation

```
COMPOSIO_POC_ENABLED=true
COMPOSIO_API_KEY=<clé du projet Composio, .env uniquement>
COMPOSIO_OUTLOOK_AUTH_CONFIG_ID=<facultatif si une seule auth config Outlook>
COMPOSIO_CALLBACK_VERIFICATION=false   # true dès qu'un domaine HTTPS public existe ; OBLIGATOIRE en production
COMPOSIO_BASE_URL=https://backend.composio.dev   # défaut, surchargeable (tests / staging)
```

- `COMPOSIO_POC_ENABLED=false` (défaut) : les routes `/api/poc/composio/*` répondent 404, la page `/poc/composio` n'existe pas, EMA fonctionne exactement comme avant.
- La clé ne quitte jamais le serveur : jamais dans Git, le frontend, les journaux, une réponse API ni un test (les tests utilisent une clé factice et un faux serveur Composio).

## Choix technique : REST plutôt que SDK

`@composio/core` 0.18 exige **Node ≥ 22.22.3** (EMA : `engines >= 20.11`, VPS en 22.22.2) et dépend d'`openai`, `pusher-js`, `undici`. Conformément à la consigne, EMA n'est pas mis à niveau pour un POC : `src/integrations/composio/client.ts` appelle l'**API REST v3.1** (URL officielle `https://backend.composio.dev`, préfixe `/api/v3.1`, en-tête `x-api-key`), contrat lu dans le client généré officiel `@composio/client` publié sur npm et dans la référence API v3.1 :

| Besoin | Endpoint |
|---|---|
| Auth configs Outlook | `GET /auth_configs?toolkit_slug=outlook` |
| Démarrer l'OAuth pour un utilisateur | `POST /connected_accounts/link` `{ auth_config_id, user_id, callback_url }` → `{ connected_account_id, redirect_url }` |
| Statut d'un compte | `GET /connected_accounts/{id}` (`INITIATED`, `ACTIVE`, `FAILED`, `EXPIRED`, `INACTIVE`, `REVOKED`, `status_reason`, `requested_scopes`) |
| Déconnexion + révocation | `DELETE /connected_accounts/{id}?revoke_on_delete=true` |
| Tools du toolkit | `GET /tools?toolkit_slug=outlook` |
| Exécution | `POST /tools/execute/{slug}` `{ connected_account_id, user_id, arguments }` → `{ successful, data, error }` |
| Callback Identity Verification | `POST /connected_accounts/complete_auth` `{ session_uri, user_id }` → `{ connected_account_id, toolkit_slug }` (200 seulement si la connexion devient ACTIVE ; 400 = identité différente → connexion `FAILED`, `status_reason` « Callback identity verification failed » ; 404 = session inconnue, expirée (10 min) ou déjà consommée) |

`input_parameters` d'un tool (v3.1) est un **mapping direct** `{ nom: { type, description, required, example } }` ; `parseInputParameters` accepte aussi, par robustesse, la forme JSON Schema `{ properties, required }`. Les noms et les paramètres requis alimentent `shapeArguments` (adaptation des arguments canoniques du POC : `limit → top | max_results`, `query → search | query`, `message_id`, `attachment_id`, `start/end → start_datetime/end_datetime`).

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
- `src/integrations/composio/policy.ts` — politique **fail-closed** et **table déterministe** (slugs exacts du catalogue Outlook actuel, aucune expression régulière de sélection) :

  | Opération | Slugs autorisés (ordre de préférence) |
  |---|---|
  | `list_recent` | `OUTLOOK_LIST_MESSAGES` |
  | `search` | `OUTLOOK_SEARCH_MESSAGES`, repli documenté `OUTLOOK_QUERY_EMAILS` |
  | `get_message` | `OUTLOOK_GET_MESSAGE` |
  | `list_attachments` | `OUTLOOK_LIST_OUTLOOK_ATTACHMENTS` |
  | `get_attachment` | `OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT` — **jamais** `OUTLOOK_GET_EVENT_ATTACHMENT` ni un tool de calendrier |
  | `list_events` | `OUTLOOK_LIST_EVENTS` |
  | `get_profile` | `OUTLOOK_GET_PROFILE` |

  Un tool n'est exécutable que s'il est dans cette table pour l'opération demandée, appartient au toolkit `outlook`, n'est pas déprécié, contient un verbe de lecture et **aucun** verbe d'écriture (`SEND|REPLY|FORWARD|DELETE|MOVE|CREATE|UPDATE|MARK|UPLOAD|BATCH|…`) et ne porte pas sur un autre objet métier (`EVENT|CALENDAR` pour une opération message / pièce jointe, `MESSAGE|MAIL|ATTACHMENT` pour le calendrier). Second contrôle `assertReadOnlySlug(slug, catalogue, opération)` juste avant `execute`. Le client n'envoie jamais un slug, seulement une opération.
- `src/integrations/composio/outlook-poc.ts` — service : connexion / statut / déconnexion **par utilisateur** (identifiant externe = `user.id`, stable ; toute exécution exige `connected_account_id` + `user_id` ; une référence pointant vers le compte d'un autre utilisateur est rejetée et supprimée), lectures avec adaptation des arguments aux paramètres déclarés par le tool, contenu binaire des pièces jointes jamais renvoyé.
- Migration `011_composio_poc` (table `composio_connections`), routes `src/app/api/poc/composio/*`, page `src/app/(app)/poc/composio`, composant `composio-poc-panel.tsx`.

Le bouton « Tools disponibles (diagnostic) » affiche les tools réellement renvoyés par Composio en trois groupes : exécutables (table), autres tools de lecture (non retenus, non exécutables), refusés (écriture / destructifs). Si une opération ne trouve pas son slug dans le catalogue, l'erreur nomme le slug attendu et liste les tools de lecture présents : mettre à jour `OPERATION_TOOLS` (aucun tool d'écriture ne peut être choisi, quelle que soit la table).

## Retour OAuth : deux modes clairement séparés

| Mode | Quand | Fonctionnement | Statut |
|---|---|---|---|
| **`verified`** — Callback Identity Verification | `COMPOSIO_CALLBACK_VERIFICATION=true` ; **obligatoire en production** (sans elle, `NODE_ENV=production` refuse toute connexion : fail-closed, aucun appel Composio) | Composio → **Settings → General → verifier URL** = `https://<APP_URL>/api/poc/composio/callback`. Le lien est créé **sans** `callback_url`. Après le consentement Microsoft, Composio ramène le navigateur sur le verifier URL avec un seul paramètre `session_uri` (aucun id de connexion, d'utilisateur ni de toolkit). EMA lit l'utilisateur de **sa session** (cookie signé), appelle côté serveur `POST /connected_accounts/complete_auth { session_uri, user_id }` avec la clé du projet ; Composio n'active la connexion que si `user_id` est bien celui qui a démarré le parcours (sinon 400 → connexion `FAILED`). EMA vérifie ensuite que le compte activé est celui référencé pour cet utilisateur. `session_uri` : usage unique, 10 minutes. | Protège contre la **session fixation** (un tiers démarre un lien puis le fait terminer par un autre utilisateur) |
| **`local`** — callback classique | Uniquement `NODE_ENV≠production`, pour un test sans domaine HTTPS public | Le lien est créé avec `callback_url` = `/api/poc/composio/callback` ; au retour, l'état est simplement relu chez Composio pour l'utilisateur de session. Aucune vérification d'identité : **le lien de connexion doit rester privé** (ne jamais le transmettre). | Affiché en avertissement dans l'interface ; **jamais production-ready** |

Sans session EMA au retour (autre navigateur, cookie perdu), rien n'est consommé : se reconnecter à EMA puis relancer la connexion depuis la page POC.

## Auth config Outlook — Composio Managed OAuth, lecture seule (procédure recommandée)

Aucune App Registration Entra n'est nécessaire pour le test : Outlook propose « Composio-managed OAuth available », et Composio permet de **personnaliser les scopes** tout en utilisant son application OAuth gérée.

1. Tableau de bord Composio → **Auth Configs** → **Create Auth Config** → toolkit **Outlook** → **Use Composio managed auth** (ne pas choisir « custom credentials »).
2. Dans le champ **Scopes** de l'auth config, remplacer les scopes par défaut par la liste **lecture seule** (forme courte Microsoft Graph, séparés par des espaces — même syntaxe que `credentials.scopes` de l'API `POST /auth_configs`, qui accepte une chaîne ou un tableau) :
   ```
   openid profile offline_access User.Read Mail.Read Calendars.Read
   ```
   **Aucun** `Mail.Send`, **aucun** `Mail.ReadWrite`, **aucun** `Calendars.ReadWrite`, aucun `MailboxSettings.*`, aucun `Files.*`.
   Équivalent programmatique : `POST /api/v3.1/auth_configs` `{ "toolkit": { "slug": "outlook" }, "auth_config": { "type": "use_composio_managed_auth", "name": "EMA POC Outlook lecture seule", "credentials": { "scopes": "openid profile offline_access User.Read Mail.Read Calendars.Read" } } }`.
3. Enregistrer, copier l'identifiant `ac_…` dans `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID`.
4. Si une auth config Outlook existait déjà avec les scopes par défaut, **ne pas la réutiliser** : les scopes déjà accordés ne sont pas retirés d'une connexion existante ; créer un nouveau lien avec la nouvelle auth config.
5. Le code affiche en alerte tout scope d'écriture que Composio renvoie malgré tout dans `requested_scopes` (`Mail.Send`, `*.ReadWrite`, `*.Write`) et refuse de toute façon toute écriture à l'exécution.
6. Tenant 3T avec consentement administrateur requis : Microsoft affiche « Need admin approval », Composio passe la connexion en `FAILED` avec le motif ; EMA affiche **« Microsoft administrator approval required. »** et ne contourne rien. Un administrateur du tenant doit approuver l'application Composio pour ces permissions déléguées (Entra → Enterprise applications → Admin consent), puis relancer la connexion.

## Smoke test réel (compte Outlook professionnel 3T)

Prérequis : `npm run db:migrate` ; `.env` avec `COMPOSIO_POC_ENABLED=true`, `COMPOSIO_API_KEY`, `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` (auth config Managed OAuth lecture seule ci-dessus) ; mode de retour : `COMPOSIO_CALLBACK_VERIFICATION=true` + verifier URL configuré si un domaine HTTPS public existe (recommandé), sinon `false` en développement uniquement ; EMA démarré ; compte EMA créé et connecté **dans le navigateur qui fera le parcours OAuth**.

| # | Test | Action | Attendu |
|---|---|---|---|
| 0 | Mode de retour | Ouvrir `/poc/composio` | En-tête « Mode de retour OAuth : vérifié » (ou « local (non production-ready) » + avertissement) ; aucun scope d'écriture signalé |
| 1 | Connexion Outlook 3T | Paramètres → Connexions → « Ouvrir le POC » → **Connecter Outlook via Composio** → connexion Microsoft 3T → consentement (scopes lecture uniquement) → retour EMA (verifier URL ou callback local) | État **Connecté**, adresse du compte affichée (`OUTLOOK_GET_PROFILE`) ; scopes demandés listés sans `Mail.Send` / `Mail.ReadWrite` |
| 2 | 5 derniers emails | **5 derniers emails** | JSON des 5 messages les plus récents de la boîte 3T, nom du tool utilisé |
| 3 | Recherche | saisir un mot (ex. objet connu) → **Rechercher** | résultats correspondants |
| 4 | Métadonnées d'un email | coller un `id` issu de 2 ou 3 → **Détails** | objet, expéditeur, dates, corps |
| 5 | Pièce jointe | **Pièces jointes** puis coller un id de pièce jointe → **Récupérer** | métadonnées (nom, taille, type) ; le contenu binaire est remplacé par « contenu binaire de N caractères non affiché » |
| 6 | Calendrier | **Calendrier** | événements des 14 prochains jours |
| 7 | Aucune écriture | **Tools disponibles (diagnostic)** | « exécutables » = uniquement les 8 slugs de la table ; `OUTLOOK_GET_EVENT_ATTACHMENT` dans « autres tools de lecture (non exécutables) » ; tous les tools SEND / REPLY / FORWARD / DELETE / MOVE / MARK / CREATE / UPDATE / UPLOAD / BATCH dans « refusés » ; aucun bouton d'écriture n'existe ; `curl -X POST /api/poc/composio/read -d '{"operation":"send_email"}'` → 400 |
| 8 | Déconnexion | **Déconnecter** | état **Déconnecté**, compte supprimé et révoqué chez Composio (`revoke_on_delete=true`) |
| 9 | Reconnexion | **Connecter Outlook via Composio** à nouveau | nouveau compte connecté (nouvel identifiant `ca_…`), état **Connecté** |
| 10 | Identité (mode vérifié) | Démarrer une connexion avec le compte EMA A, copier l'URL Microsoft, la terminer dans un navigateur connecté au compte EMA B | B obtient « Callback identity verification failed », la connexion de A passe en **Erreur** ; rien n'est activé |

Contrôles transverses : `grep -r "<clé>" logs/` ne renvoie rien ; `sqlite3 data/ema.db "select * from composio_connections"` ne contient aucun token ; un second compte EMA (autre navigateur) voit **Déconnecté** et ne peut rien lire (isolation).

## Limites du POC

- Slugs Outlook fixés d'après le catalogue actuel fourni par l'audit (`OUTLOOK_LIST_MESSAGES`, `OUTLOOK_SEARCH_MESSAGES`, `OUTLOOK_QUERY_EMAILS`, `OUTLOOK_GET_MESSAGE`, `OUTLOOK_LIST_OUTLOOK_ATTACHMENTS`, `OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT`, `OUTLOOK_LIST_EVENTS`, `OUTLOOK_GET_PROFILE`) ; leurs noms de paramètres sont lus dans `input_parameters` à l'exécution. Le catalogue complet (305 tools) n'a pas pu être relu hors ligne : le diagnostic à l'écran fait foi.
- Mode `local` : aucune protection contre la session fixation ; réservé au développement sans domaine public, jamais en production (fail-closed).
- Lecture seule ; aucune intégration au worker, aux tools Claude, à l'Action Engine ni à WhatsApp.
- L'adresse du compte dépend d'un tool de profil Outlook côté Composio ; à défaut, l'état reste « Connecté » sans adresse.
- Les scopes OAuth réels dépendent de l'auth config Composio (à restreindre côté Composio / Entra) ; le code ne peut que les afficher et refuser les écritures à l'exécution.
