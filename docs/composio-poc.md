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
- `src/integrations/composio/preflight.ts` — preflight (état / configuration uniquement, présence des variables sans leur valeur, migration, base, Graph natif intact, tools attendus, capacités) exposé par `GET /api/poc/composio/preflight` (authentifié, POC activé).
- Migration `011_composio_poc` (table `composio_connections`), routes `src/app/api/poc/composio/*`, page `src/app/(app)/poc/composio` (preflight + smoke test guidé), composant `composio-poc-panel.tsx`.

Le bouton « Tools disponibles (diagnostic WRITE = 0) » affiche les tools réellement renvoyés par Composio en trois groupes : exécutables (table), lecture non retenue (non exécutables), écriture / destructifs refusés, avec le résumé `WRITE tools executable = N` (`summarizeTools`) : N doit valoir 0, sinon le POC est déclaré en échec. Si une opération ne trouve pas son slug dans le catalogue, l'erreur nomme le slug attendu et liste les tools de lecture présents : mettre à jour `OPERATION_TOOLS` (aucun tool d'écriture ne peut être choisi, quelle que soit la table).

## Retour OAuth : deux modes clairement séparés

| Mode | Quand | Fonctionnement | Statut |
|---|---|---|---|
| **`verified`** — Callback Identity Verification | `COMPOSIO_CALLBACK_VERIFICATION=true` ; **obligatoire en production** (sans elle, `NODE_ENV=production` refuse toute connexion : fail-closed, aucun appel Composio) | Composio → **Settings → General → verifier URL** = `https://<APP_URL>/api/poc/composio/callback`. Le lien est créé **sans** `callback_url`. Après le consentement Microsoft, Composio ramène le navigateur sur le verifier URL avec un seul paramètre `session_uri` (aucun id de connexion, d'utilisateur ni de toolkit) ; **sans `session_uri`, la route refuse** (aucun appel). EMA exige d'abord une connexion **en attente mémorisée localement** pour l'utilisateur de sa session (cookie signé) — sinon refus **avant** tout appel, rien n'est activé — puis appelle côté serveur `POST /connected_accounts/complete_auth { session_uri, user_id }` avec la clé du projet ; Composio n'active la connexion que si `user_id` est bien celui qui a démarré le parcours (sinon 400 → connexion `FAILED`). Si le compte activé n'est pas celui référencé localement : refus, **révocation best-effort du compte étranger** (`DELETE …?revoke_on_delete=true`, échec journalisé sans secret), référence locale en erreur — jamais remplacée. `session_uri` : usage unique, 10 minutes. | Protège contre la **session fixation** (un tiers démarre un lien puis le fait terminer par un autre utilisateur) |
| **`local`** — callback classique | Uniquement `NODE_ENV≠production`, pour un test sans domaine HTTPS public | Le lien est créé avec `callback_url` = `/api/poc/composio/callback` ; au retour, `complete_auth` n'est **jamais** appelé, l'état est simplement relu chez Composio pour l'utilisateur de session. Un `session_uri` reçu dans ce mode révèle une incohérence de configuration (verifier URL actif côté Composio) : il n'est pas consommé, l'écran l'indique. Aucune vérification d'identité : **le lien de connexion doit rester privé** (ne jamais le transmettre). | Affiché en avertissement dans l'interface ; **jamais production-ready** |

Sans session EMA au retour (autre navigateur, cookie perdu), rien n'est consommé : se reconnecter à EMA puis relancer la connexion depuis la page POC.

## Auth config Outlook — Composio Managed OAuth, lecture seule (procédure recommandée)

Aucune App Registration Entra n'est nécessaire pour le test : Outlook propose « Composio-managed OAuth available », et Composio permet de **personnaliser les scopes** tout en utilisant son application OAuth gérée.

1. Tableau de bord Composio → **Auth Configs** → **Create Auth Config** → toolkit **Outlook** → **Use Composio managed auth** (ne pas choisir « custom credentials »).
2. Dans le champ **Scopes** de l'auth config, remplacer les scopes par défaut par la liste **lecture seule** (forme courte Microsoft Graph, **séparés par des virgules** — c'est la syntaxe attendue par Composio pour `credentials.scopes` en Managed OAuth ; helper `managedOAuthScopes()` dans `policy.ts`) :
   ```
   openid,profile,offline_access,User.Read,Mail.Read,Calendars.Read
   ```
   **Aucun** `Mail.Send`, **aucun** `Mail.ReadWrite`, **aucun** `Calendars.ReadWrite`, aucun `MailboxSettings.*`, aucun `Files.*`.
   Équivalent programmatique : `POST /api/v3.1/auth_configs` `{ "toolkit": { "slug": "outlook" }, "auth_config": { "type": "use_composio_managed_auth", "name": "EMA POC Outlook lecture seule", "credentials": { "scopes": "openid,profile,offline_access,User.Read,Mail.Read,Calendars.Read" } } }`.
3. Enregistrer, copier l'identifiant `ac_…` dans `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID`.
4. Si une auth config Outlook existait déjà avec les scopes par défaut, **ne pas la réutiliser** : les scopes déjà accordés ne sont pas retirés d'une connexion existante ; créer un nouveau lien avec la nouvelle auth config.
5. Le code affiche en alerte tout scope d'écriture que Composio renvoie malgré tout dans `requested_scopes` (`Mail.Send`, `*.ReadWrite`, `*.Write`) et refuse de toute façon toute écriture à l'exécution.
6. Tenant 3T avec consentement administrateur requis : Microsoft affiche « Need admin approval », Composio passe la connexion en `FAILED` avec le motif ; EMA affiche **« Microsoft administrator approval required. »** et ne contourne rien. Un administrateur du tenant doit approuver l'application Composio pour ces permissions déléguées (Entra → Enterprise applications → Admin consent), puis relancer la connexion.

## Avant le test réel

Le preflight de la page `/poc/composio` (route `GET /api/poc/composio/preflight`, utilisateur authentifié, POC activé) vérifie l'état de la configuration **sans jamais afficher une valeur secrète** : chaque variable sensible est réduite à « présente / absente ». Contrôles : `COMPOSIO_POC_ENABLED`, `COMPOSIO_API_KEY` (présente / absente), `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` (présent / absent), mode de retour OAuth (`local` / `verified`), sécurité production (échec si `NODE_ENV=production` sans vérification d'identité), `APP_URL` (HTTPS en production) et URL du callback, URL de base Composio (HTTPS), base SQLite accessible, migration `011_composio_poc` appliquée (table `composio_connections`), Microsoft Graph natif intact (scopes délégués inchangés), configuration EMA bloquante, nombre de tools Outlook exécutables attendus (8), capacités autorisées (`email.read`, `email.search`, `attachment.read`, `calendar.read`). Jamais affichés : clé API, token, client secret, refresh token, access token.

Checklist (tout doit être coché avant d'ouvrir le navigateur du dirigeant 3T) :

- [ ] `npm run check` vert (typecheck, lint, tests, build)
- [ ] migrations appliquées (`npm run db:migrate` ; preflight « Migration 011_composio_poc : OK »)
- [ ] clé Composio dans `.env` (`COMPOSIO_API_KEY`, jamais ailleurs ; preflight « présente »)
- [ ] auth config Outlook **lecture seule** créée dans Composio (Managed OAuth, scopes `openid,profile,offline_access,User.Read,Mail.Read,Calendars.Read`)
- [ ] `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` configuré (preflight « présent »)
- [ ] mode de retour choisi : `COMPOSIO_CALLBACK_VERIFICATION=true` + verifier URL `https://<APP_URL>/api/poc/composio/callback` dans Composio (recommandé, obligatoire en production) — ou `false` en développement uniquement, lien gardé privé
- [ ] compte EMA créé et connecté **dans le navigateur qui fera le parcours OAuth**
- [ ] aucun scope WRITE (aucun `Mail.Send`, `*.ReadWrite`, `*.Write` dans l'auth config ; la page signale en rouge tout scope d'écriture renvoyé par Composio)
- [ ] aucun secret dans Git (`git grep -i "composio_api_key=" -- ':!.env.example'` vide ; `.env` ignoré)

## Test réel Outlook 3T

Le tableau « Smoke test guidé » de la page `/poc/composio` suit les 12 étapes ci-dessous et affiche pour chacune **PAS TESTÉ / OK / ÉCHEC**. Il ne vit que dans l'onglet du navigateur (`sessionStorage`, uniquement des états par numéro d'étape : aucun identifiant, aucune adresse, aucun contenu lu) ; « Réinitialiser le tableau » l'efface. Rien n'est stocké en base pour ce tableau.

| # | Étape | Action | Attendu (OK) |
|---|---|---|---|
| 0 | Preflight | Ouvrir `/poc/composio` (preflight calculé au chargement) ou **Relancer le preflight** | Badge **PRÊT**, aucun contrôle en FAIL ; mode `verified` (ou `local` en avertissement hors production) |
| 1 | Connecter Outlook | **Connecter Outlook via Composio** (désactivé tant que le preflight n'est pas prêt) → connexion Microsoft 3T → consentement (scopes lecture uniquement) → retour EMA | Au retour, état **Connecté** ; l'étape passe OK automatiquement, ÉCHEC si le retour est refusé |
| 2 | Vérifier l'identité du compte | Automatique au retour, ou **Vérifier l'identité / la connexion** | Adresse du compte 3T affichée (`OUTLOOK_GET_PROFILE`) ; scopes demandés sans `Mail.Send` / `Mail.ReadWrite` |
| 3 | Lire les 5 derniers emails | **3. 5 derniers emails** | JSON des 5 messages les plus récents, tool `OUTLOOK_LIST_MESSAGES` |
| 4 | Rechercher un email | saisir un mot (objet connu) → **Rechercher** | résultats correspondants (`OUTLOOK_SEARCH_MESSAGES` ou `OUTLOOK_QUERY_EMAILS`) |
| 5 | Lire les détails d'un email | coller un `id` issu de 3 ou 4 → **5. Détails** | objet, expéditeur, dates, corps (`OUTLOOK_GET_MESSAGE`) |
| 6 | Lister les pièces jointes | **6. Pièces jointes** sur un message qui en a | liste des pièces jointes avec identifiants (`OUTLOOK_LIST_OUTLOOK_ATTACHMENTS`) |
| 7 | Récupérer une pièce jointe | coller un id de pièce jointe → **Récupérer** | métadonnées (nom, taille, type) ; le contenu binaire est remplacé par « contenu binaire de N caractères non affiché » (`OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT`) |
| 8 | Lire le calendrier | **8. Calendrier** | événements des 14 prochains jours (`OUTLOOK_LIST_EVENTS`) |
| 9 | Aucun tool WRITE exécutable | **9. Tools disponibles (diagnostic WRITE = 0)** | Résumé **WRITE tools executable = 0** ; « exécutables » = uniquement les 8 slugs de la table ; `OUTLOOK_GET_EVENT_ATTACHMENT` dans « lecture non retenue » ; SEND / REPLY / FORWARD / DELETE / MOVE / MARK / CREATE / UPDATE / UPLOAD / BATCH dans « écriture / destructifs refusés ». **Si le compteur n'est pas 0, le POC est en échec** (bandeau rouge) : arrêter le test. Complément : `curl -X POST /api/poc/composio/read -d '{"operation":"send_email"}'` → 400 |
| 10 | Déconnexion | **Déconnecter** | état **Déconnecté**, compte supprimé et révoqué chez Composio (`revoke_on_delete=true`) |
| 11 | Reconnexion | **Reconnecter Outlook via Composio** → même parcours qu'en 1 | nouveau compte connecté (nouvel identifiant `ca_…`), état **Connecté** ; l'étape 11 passe OK au retour |

Contrôle complémentaire (mode vérifié) : démarrer une connexion avec le compte EMA A, copier l'URL Microsoft, la terminer dans un navigateur connecté au compte EMA B → B obtient un refus, la connexion de A passe en **Erreur**, rien n'est activé.

Contrôles transverses après le test : `grep -r "<clé>" logs/` ne renvoie rien ; `sqlite3 data/ema.db "select * from composio_connections"` ne contient aucun token ; un second compte EMA (autre navigateur) voit **Déconnecté** et ne peut rien lire (isolation) ; la boîte 3T ne contient aucun brouillon, envoi, déplacement ni marquage créé pendant le test.

Résultat attendu pour valider le POC : étapes 0 à 11 **OK**, `WRITE tools executable = 0`, aucun scope d'écriture signalé, aucune fuite de secret.

## Limites du POC

- Slugs Outlook fixés d'après le catalogue actuel fourni par l'audit (`OUTLOOK_LIST_MESSAGES`, `OUTLOOK_SEARCH_MESSAGES`, `OUTLOOK_QUERY_EMAILS`, `OUTLOOK_GET_MESSAGE`, `OUTLOOK_LIST_OUTLOOK_ATTACHMENTS`, `OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT`, `OUTLOOK_LIST_EVENTS`, `OUTLOOK_GET_PROFILE`) ; leurs noms de paramètres sont lus dans `input_parameters` à l'exécution. Le catalogue complet (305 tools) n'a pas pu être relu hors ligne : le diagnostic à l'écran fait foi.
- Mode `local` : aucune protection contre la session fixation ; réservé au développement sans domaine public, jamais en production (fail-closed).
- Lecture seule ; aucune intégration au worker, aux tools Claude, à l'Action Engine ni à WhatsApp.
- L'adresse du compte dépend d'un tool de profil Outlook côté Composio ; à défaut, l'état reste « Connecté » sans adresse.
- Les scopes OAuth réels dépendent de l'auth config Composio (à restreindre côté Composio / Entra) ; le code ne peut que les afficher et refuser les écritures à l'exécution.
