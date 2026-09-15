# Outlook / Microsoft Graph — Phase 1

Ce document décrit comment EMA se connecte à **une seule** boîte Outlook, ce qu'il lit, ce qu'il envoie, et ce qu'il ne fait jamais.

## 1. Permissions Microsoft Graph (déléguées)

| Permission | Pourquoi | Appels |
|---|---|---|
| `offline_access` | Obtenir un refresh token : l'autorisation survit à l'expiration de l'access token (~1 h) | `/oauth2/v2.0/token` |
| `User.Read` | Connaître l'adresse de la mailbox connectée | `GET /me` |
| `Mail.Read` | Lire les messages, les conversations, les pièces jointes, la delta query, la recherche | `GET /me/mailFolders/inbox/messages/delta`, `GET /me/messages…`, `GET /me/messages/{id}/attachments…` |
| `Mail.Send` | Répondre, transférer, envoyer | `POST /me/messages/{id}/reply`, `/replyAll`, `/forward`, `POST /me/sendMail` |

**Pas de `Mail.ReadWrite`** : EMA ne crée pas de brouillon, ne marque rien comme lu, ne déplace, n'archive et ne supprime aucun email. Les envois passent par les actions directes `reply` / `forward` / `sendMail` qui ne nécessitent que `Mail.Send`.

Ces quatre permissions sont demandées telles quelles dans l'URL d'autorisation (`GRAPH_SCOPES`, `src/integrations/microsoft/oauth.ts`). Dans Azure, déclarez-les en **Delegated permissions** sur l'App registration ; aucune permission d'application (`Mail.Read` application-wide) n'est utilisée.

> Vérification : ce jeu de permissions correspond aux tables « Permissions » de la documentation Microsoft Graph pour `message: delta`, `message: get`, `attachment: get`, `message: reply/forward`, `user: sendMail` (niveau *least privileged*). À contrôler lors de la création de l'App registration si Microsoft fait évoluer ces exigences.

## 2. Configuration Azure

1. Portail Azure → *App registrations* → *New registration* (comptes : « Accounts in this organizational directory only » ou « any organizational directory » selon le client ; `MICROSOFT_TENANT_ID` = id du tenant, ou `common`).
2. *Authentication* → plateforme **Web** → Redirect URI : `https://ema.client.fr/api/integrations/microsoft/callback` (identique à `MICROSOFT_REDIRECT_URI`).
3. *Certificates & secrets* → *New client secret* → `MICROSOFT_CLIENT_SECRET`.
4. *API permissions* → Microsoft Graph → Delegated : `User.Read`, `Mail.Read`, `Mail.Send`, `offline_access` → *Grant admin consent* si le tenant l'exige.

## 3. Flux OAuth (authorization code)

```
/setup → [Connecter Outlook]
  → GET /api/integrations/microsoft/connect      crée un état anti-CSRF (settings_kv, 10 min, usage unique)
  → https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?…&scope=offline_access User.Read Mail.Read Mail.Send
  → l'utilisateur s'authentifie chez Microsoft (EMA ne voit jamais le mot de passe)
  → GET /api/integrations/microsoft/callback?code=…&state=…
      vérifie l'état → POST /token (grant authorization_code) → GET /me
      → oauth_tokens : { access_token, refresh_token, expires_at, scope } chiffré AES-256-GCM (clé dérivée d'APP_SECRET)
  → redirection /setup?step=outlook&connected=1
```

Routes :

| Route | Méthode | Rôle |
|---|---|---|
| `/api/integrations/microsoft/connect` | GET | Redirige vers Microsoft |
| `/api/integrations/microsoft/callback` | GET | Échange le code, stocke les tokens |
| `/api/integrations/microsoft/status` | GET | État (adresse, permissions, dernière synchro, dernier email, erreur) ; `?test=1` fait un `GET /me` réel |
| `/api/integrations/microsoft/sync` | POST | Synchronisation manuelle (même verrou que le worker) |
| `/api/integrations/microsoft/disconnect` | POST | Supprime les tokens et le curseur de synchronisation |

Toutes ces routes exigent la session de l'interface. Les tokens ne sortent jamais de `src/integrations/microsoft/` (`token-store.ts`, `graph-client.ts`) et ne sont jamais loggués (`redact()` masque de toute façon les clés `token`/`secret`).

## 4. Renouvellement

`createConnectedGraphClient()` :
- rafraîchit le token **avant** l'appel si l'expiration est à moins de 2 minutes ;
- sur **401**, rafraîchit une fois et rejoue la requête ;
- si Microsoft ne renvoie pas de nouveau refresh token, l'ancien est conservé ;
- un seul rafraîchissement à la fois par process (mutex).

Si le refresh échoue (refresh token révoqué, mot de passe changé, consentement retiré), l'appel échoue avec `INTEGRATION` et l'interface affiche l'erreur dans « Dernière erreur ». Il faut alors *Déconnecter* puis *Connecter Outlook* à nouveau.

## 5. Client Graph

`GraphClient` (`graph-client.ts`) centralise tous les appels :

| Cas | Comportement |
|---|---|
| 401 | refresh + 1 rejeu |
| 429 | attente `Retry-After` (max 60 s) puis rejeu, 3 tentatives |
| 500 / 502 / 503 / 504 | backoff exponentiel (1 s, 2 s, 4 s…), 3 tentatives |
| autres 4xx | `GraphError` (code Graph + statut HTTP, message tronqué, jamais de secret) |
| panne réseau | 3 tentatives puis `INTEGRATION` |
| pagination | `getAll()` suit `@odata.nextLink` jusqu'à une limite explicite |

## 6. Synchronisation (ingestion)

`syncInbox()` (`sync.ts`), exécutée par le worker (`scan_mailbox`, toutes les `WORKER_POLL_INTERVAL` secondes) et par le bouton *Synchroniser maintenant* :

1. **Delta query** sur la boîte de réception : `GET /me/mailFolders/inbox/messages/delta?$select=…`. Le curseur (`@odata.nextLink` ou `@odata.deltaLink`) est conservé dans `settings_kv` (`outlook.sync_cursor`). Les passages suivants ne relisent jamais toute la boîte : Graph ne renvoie que les messages nouveaux ou modifiés.
2. **Première synchronisation** bornée par `EMAIL_INITIAL_SYNC_DAYS` (`$filter=receivedDateTime ge …`, défaut 7 jours ; 0 = tout).
3. **Limite par passage** `EMAIL_SYNC_LIMIT` (défaut 50, `20` recommandé en test) : une page est toujours traitée en entier, puis le curseur `nextLink` est conservé pour le passage suivant. Garde-fou : 20 pages max par passage.
4. Pour chaque message : brouillons ignorés, entrées `@removed` ignorées, **doublon** si `graph_id` déjà connu (seul `is_read` est mis à jour). Sinon insertion dans `emails` avec `status = NEW`, `direction = inbound`, corps texte (`Prefer: outlook.body-content-type="text"`), `internet_message_id`, `thread_id` (= `conversationId`), destinataires, `web_link`.
5. Pièces jointes des nouveaux emails : voir §8.
6. État écrit dans `settings_kv` : `outlook.last_sync_at`, `outlook.last_email_at`, `outlook.last_sync_error`, `outlook.last_sync_result` ; une ligne `history` `outlook.sync` quand des emails ont été ingérés.

EMA **ne modifie jamais** la boîte pendant la synchronisation : pas de marquage lu, pas de déplacement, pas de suppression, pas d'archivage.

Le traitement Claude d'un email `NEW` arrive en phase 2 ; en phase 1 les emails restent `NEW` et sont visibles dans l'interface.

## 7. Threads

`get_email_thread` (tool) → `importConversation()` :
- `GET /me/messages?$filter=conversationId eq '…'&$select=…` (tous dossiers : reçus **et** envoyés), 30 messages max, tri chronologique côté EMA ;
- les messages inconnus sont enregistrés avec `status = CONTEXT` (jamais traités comme nouveaux, jamais comptés dans « emails analysés ») ; la direction est déduite de l'adresse connectée ;
- le tool renvoie au plus 20 messages, corps tronqué à 8 000 caractères chacun.

Sans connexion Outlook, le thread est reconstitué depuis SQLite seul.

## 8. Pièces jointes

- Liste : `GET /me/messages/{id}/attachments?$select=id,name,contentType,size,isInline` ; seuls les `fileAttachment` non inline sont pris (les images de signature inline et les emails joints sont ignorés).
- Téléchargement : `GET …/attachments/{id}/$value` (octets bruts).
- **Refus** : extensions exécutables/scripts (`exe`, `bat`, `js`, `ps1`, `jar`, `lnk`, `sh`… liste `DANGEROUS_EXTENSIONS`, double extension incluse) et types MIME exécutables ; taille > `ATTACHMENT_MAX_MB` (défaut 15). Chaque refus est journalisé (`document.refused`).
- Stockage : `private/documents/<yyyy>/<mm>/<doc_id>-<nom-assaini>` ; jamais dans `public/` ; servi uniquement via `/api/documents/{id}/file` après authentification. Aucune pièce jointe n'est jamais exécutée.
- SQLite `documents` : email source, `attachment_id`, nom original, `stored_name`, type MIME, taille, chemin relatif, `sha256`, statut. Index unique `(email_id, attachment_id)` : jamais deux fois le même fichier.
- `get_attachment` (tool) télécharge à la demande une pièce jointe non encore archivée.

## 9. Envoi (jamais direct)

```
Claude / tool (reply_email, forward_email, send_email)
  → Action Engine : action MEDIUM/HIGH, WAITING_APPROVAL
  → validation (WhatsApp en phase 3, ou page « À valider »)
  → executeAction : transition atomique APPROVED → EXECUTING
  → exécuteur Outlook (src/actions/executors/outlook.ts)
  → POST /me/messages/{id}/reply | /forward | POST /me/sendMail
  → message envoyé retrouvé dans Sent Items et tracé comme email sortant (best effort)
```

Les primitives Graph d'envoi (`mail.ts` : `replyToMessage`, `forwardMessage`, `sendMail`) ne sont appelées **que** par les exécuteurs. Les pièces jointes sortantes proviennent de `documents` (base64 inline, adapté aux PDF signés).

## 10. Mode test

```
EMAIL_SYNC_LIMIT=20
EMAIL_INITIAL_SYNC_DAYS=2
ATTACHMENT_MAX_MB=5
```

Les tests automatisés (`tests/microsoft-*.test.ts`, `tests/outlook-executors.test.ts`) utilisent un faux `fetch` : aucun appel réseau, aucun email réel envoyé.

## 11. Limites connues

- Seule la **boîte de réception** est synchronisée (pas les sous-dossiers ni les règles de tri Outlook qui déplacent un message avant lecture). Un message déplacé hors de la boîte de réception n'est pas ingéré.
- Le message envoyé est retrouvé par `conversationId` dans *Sent Items* ; si Outlook met du temps à le classer, la trace sortante peut manquer (l'action reste `COMPLETED`).
- Les pièces jointes sortantes sont envoyées en base64 inline (limite pratique ~3 Mo par fichier côté Graph).
- La recherche `$search` renvoie au plus 50 résultats, sans tri garanti par date.
