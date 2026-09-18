# WhatsApp — numéro EMA central, identification par utilisateur

## 0. Modèle (18/09/2026)

**UN numéro WhatsApp Business appartient à EMA** (API officielle Meta, WhatsApp Business Platform). Chaque dirigeant écrit à ce numéro depuis son WhatsApp personnel — qui n'est **jamais** connecté à EMA (ni session, ni QR code, ni contacts, ni appareils).

```
+33 6 12 34 56 78 (dirigeant A) ─┐
+33 6 98 76 54 32 (dirigeant B) ─┼─▶ numéro EMA ─▶ webhook signé ─▶ identifySender(from)
+33 6 11 22 33 44 (dirigeant C) ─┘        └─ users.phone_number (E.164, vérifié) → user_id → connexion Microsoft → tools → réponse
```

- **Activation** : l'utilisateur saisit son numéro dans Paramètres → Connexions → WhatsApp (`POST /api/me/phone`, normalisé E.164, unique parmi les comptes actifs, `phone_verified = 0`), puis envoie « Bonjour EMA » via le bouton **Ouvrir WhatsApp** (`wa.me/<WHATSAPP_BUSINESS_NUMBER>?text=Bonjour%20EMA`). Le premier message reçu depuis ce numéro l'associe définitivement (`phone_verified = 1`, `whatsapp_enabled = 1`, `verified_at`) et EMA répond par un message de bienvenue. Pas d'infrastructure SMS.
- **Numéro inconnu** : « Ce numéro n'est pas encore associé à un compte EMA. Connectez-vous à votre espace EMA (Paramètres → Connexions → WhatsApp) pour activer WhatsApp. » — aucun appel Microsoft, aucun appel Claude, aucune donnée, réponse limitée à 3 par heure, journal `whatsapp.unknown_number` sans le numéro complet (code `UNKNOWN_USER`).
- **Désactivation** : `DELETE /api/me/phone` retire le numéro ; EMA ne répond plus.
- **Isolation** : les actions en attente, les références numérotées, l'historique de conversation et les tools sont scopés par `user_id` ; un utilisateur ne valide que ses propres actions.
- **Diagnostic** (journaux, jamais de secret ni de numéro complet) : `whatsapp message identified` → `whatsapp assistant turn` → `tool failed` / résultats → `whatsapp reply sent` (tools appelés, `reconnectRequired`).

## 1. Rôle

WhatsApp est le canal de validation humaine et de dialogue d'EMA. Chaque action sensible (réponse email en phase 3 ; transferts, paiements, signatures dans les phases suivantes) produit **une** demande de validation avec deux boutons : ✅ Valider / ❌ Refuser. Rien n'est envoyé tant que l'utilisateur n'a pas validé.

```
Claude → reply_draft → action reply_email (PROPOSED → WAITING_APPROVAL) → approval PENDING
      → message WhatsApp (boutons approve:<approval_id> / reject:<approval_id>)
      → webhook Meta → numéro autorisé ? → approval PENDING et non expirée ?
      → Action Engine : APPROVED → EXECUTING (transition atomique) → exécuteur Outlook → COMPLETED | FAILED
      → confirmation WhatsApp + history
```

## 2. Configuration (`.env`)

| Variable | Rôle |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Token permanent (System User) de l'app Meta. Jamais loggué. |
| `WHATSAPP_PHONE_NUMBER_ID` | Identifiant du numéro émetteur WhatsApp Business |
| `WHATSAPP_VERIFY_TOKEN` | Jeton de vérification de l'abonnement webhook (GET) |
| `WHATSAPP_APP_SECRET` | Secret de l'app Meta : signature `X-Hub-Signature-256` des webhooks. **Obligatoire en production** (webhook refusé sinon). |
| `WHATSAPP_BUSINESS_NUMBER` | Numéro WhatsApp Business d'EMA au format E.164 (ex. `+33700000000`), affiché aux utilisateurs pour le bouton « Ouvrir WhatsApp » |
| `WHATSAPP_APPROVER_PHONE` | **Obsolète comme identité.** Sert uniquement de destinataire au « message de test » de la page Paramètres. Les demandes de validation partent vers le numéro vérifié du propriétaire de chaque action. |
| `WHATSAPP_API_VERSION` | Version de l'API Graph Meta (`v21.0`) |

Côté Meta for Developers : app → WhatsApp → *Configuration* → Webhook : URL `https://ema.client.fr/api/integrations/whatsapp/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`, champ `messages`. Le numéro autorisé doit avoir accepté de recevoir des messages du numéro Business (en test Meta, l'ajouter aux destinataires autorisés ; en production, une conversation « service » ou un template peut être nécessaire selon la fenêtre de 24 h — voir §9).

## 3. Message de validation

Envoyé par `buildApprovalMessages()` (`src/integrations/whatsapp/messages.ts`) :

```
📩 EMA — Réponse à valider

De : Jean Dupont <jean@abc.fr>
Entreprise : ABC
Objet : Paiement facture septembre

Résumé : Le fournisseur demande quand le règlement sera effectué.

Action proposée : Répondre à l'email dans le thread

Réponse proposée :
"Bonjour Jean,
…"

Confiance : 94 %
⚠ Validation humaine requise      (si l'analyse l'exige)

[ ✅ Valider ]  [ ❌ Refuser ]
```

Message **interactif à boutons** (API `interactive.button`, identifiants `approve:<approval_id>` / `reject:<approval_id>`). Si le corps dépasse la limite Meta (1 024 caractères), le détail complet part en message texte, suivi d'un message interactif court portant les boutons. Jamais de secret ni de pièce jointe brute.

## 4. Approvals (table `approvals`, Action Engine)

Réutilise la table et l'engine de la phase 0, sans système parallèle :

| Champ | Rôle |
|---|---|
| `id` (`apr_…`) | identifiant encodé dans les boutons |
| `action_id` | action liée |
| `status` | `PENDING` → `APPROVED` / `REJECTED` / `EXPIRED` |
| `expires_at` | `settings.approvals.expireAfterHours` (48 h par défaut) |
| `external_message_id`, `sent_at`, `notify_attempts`, `last_notify_error` | suivi de la notification (une seule notification active) |
| `decided_by`, `decided_at`, `comment` | décision (`whatsapp:3361…78`, `user`, `system`) |

Propriétés : usage unique (`decideApproval` ne modifie que si `PENDING`), limitée dans le temps, liée à une action, impossible à rejouer.

## 5. Webhook (`/api/integrations/whatsapp/webhook`)

- **GET** : vérification Meta (`hub.mode=subscribe`, `hub.verify_token` comparé en temps constant) → renvoie `hub.challenge`.
- **POST** : corps brut lu tel quel, signature `X-Hub-Signature-256` vérifiée avec `WHATSAPP_APP_SECRET` (401 sinon ; 503 en production si le secret manque). JSON validé par zod (`parseWebhook`) : seuls les messages utilisateur sont retenus (les statuts *delivered/read* sont ignorés) ; tout corps malformé est ignoré avec une réponse 200.
- Chaque événement passe par `handleInboundEvent()` :
  1. expéditeur = `WHATSAPP_APPROVER_PHONE` (sinon `unauthorized`, aucune trace de décision) ;
  2. dédoublonnage par identifiant Meta (`webhook_events`, unique) → `duplicate` si rejeu ;
  3. identifiant de bouton `approve:`/`reject:` valide, approval existante ;
  4. approval `PENDING` (sinon `already_decided`) et non expirée (sinon `EXPIRED`, action non exécutée) ;
  5. **Valider** → `approveAndExecute()` (Action Engine) ; **Refuser** → `rejectAction()` ;
  6. confirmation WhatsApp (✅ fait / ❌ refusé / ⚠ échec / ℹ déjà traité), résultat enregistré dans `webhook_events.result`.

Routes annexes (session requise) : `GET /api/integrations/whatsapp/status`, `POST /api/integrations/whatsapp/test` (envoie « ✅ EMA est correctement connecté à WhatsApp. »).

## 6. Anti-double-exécution

Quatre barrières indépendantes :
1. `webhook_events` : un identifiant de message Meta n'est traité qu'une fois (rejeu du webhook).
2. `approvals.status` : décision à usage unique (`UPDATE … WHERE status = 'PENDING'`).
3. `actions` : transition atomique `APPROVED → EXECUTING` (`UPDATE … WHERE status = 'APPROVED'`, exactement une ligne) avant tout effet de bord — c'est ce qui protège contre une validation simultanée interface + WhatsApp ou deux workers.
4. Le refresh de l'interface et les confirmations WhatsApp reflètent l'état réel (`COMPLETED`, `FAILED`, `REJECTED`).

Tests : double clic, rejeu du même webhook, validation UI + WhatsApp en parallèle → un seul `POST /reply` Graph.

## 7. Interface « À valider »

Pour chaque action en attente : expéditeur, objet, société, résumé EMA, confiance, réponse proposée, état de la notification WhatsApp. Boutons : **Modifier** (le texte modifié devient le payload définitif, historique `action.payload_edited`, approval mise à jour), **Valider et envoyer** (confirmation puis exécution réelle), **Refuser**, **Renvoyer la demande** (après expiration ou échec d'envoi : nouvelle approval liée à la même action, jamais de doublon si une demande est encore `PENDING`). Statuts affichés : En attente, Validé, Envoyé, Refusé, Expiré, Échec (+ **Réessayer l'envoi** pour une action `FAILED`, déjà validée).

## 8. Expiration et notifications

- Worker `expire_approvals` (10 min) : `PENDING` échues → `EXPIRED`. L'action reste `WAITING_APPROVAL`, **jamais exécutée** ; l'interface l'indique et propose « Renvoyer la demande ».
- Worker `notify_approvals` (2 min) : renvoie les demandes `PENDING` jamais parties (WhatsApp indisponible), 5 tentatives maximum, erreur visible dans l'interface.
- Une réanalyse d'un email dont la réponse est déjà en attente met à jour le brouillon existant : une seule action, une seule demande active.

## 9. Erreurs gérées

| Cas | Comportement |
|---|---|
| WhatsApp injoignable / 5xx / 429 | 2 réessais (Retry-After respecté), puis échec enregistré sur l'approval et relance par le worker |
| Meta 400 / 401 (token) | échec immédiat, message explicite dans l'interface et `history` |
| Webhook sans signature valide | 401, rien traité |
| Corps malformé | 200, rien traité |
| Approval inexistante / expirée / déjà décidée | réponse WhatsApp informative, aucune exécution |
| Numéro non autorisé | ignoré silencieusement (journal applicatif, numéro masqué) |
| Graph indisponible ou refus d'envoi après validation | action `FAILED`, email **non** considéré comme envoyé, ⚠ sur WhatsApp, bouton « Réessayer l'envoi » |

## 10. Historique

`action.proposed`, `approval.requested`, `action.draft_created`, `approval.sent` / `approval.send_failed`, `approval.approved` / `approval.rejected` / `approval.expired`, `action.payload_edited`, `action.completed` / `action.failed`, `action.retry`. Aucun token, aucun numéro complet.

## 11. Limitations

- Fenêtre de messagerie Meta : hors d'une conversation ouverte dans les 24 h, un message libre peut être refusé par Meta (code 131047) ; il faut alors un template approuvé ou que l'utilisateur écrive d'abord au numéro Business. Le message de test permet de vérifier l'état.
- Le traitement du webhook (dont l'envoi Graph) se fait avant la réponse HTTP ; Meta tolère quelques secondes.
- La modification du brouillon se fait depuis l'interface EMA, pas depuis WhatsApp.
- Seule la réponse email est créée automatiquement en phase 3 ; transferts, paiements et signatures seront branchés sur le même mécanisme dans les phases suivantes.
