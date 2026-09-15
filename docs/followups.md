# Relances intelligentes et rappels internes (Phase 7)

EMA programme une relance, mémorise exactement quel échange elle surveille, **relit le thread dans Outlook à l'échéance**, annule d'elle-même si une réponse est arrivée, et sinon prépare une relance contextualisée soumise à validation. Aucune relance n'est envoyée sans validation humaine.

```
Email envoyé ──► relance prévue (watch_after = dernier message sortant)
             ──► échéance ──► vérification Microsoft Graph OBLIGATOIRE
                   ├── réponse humaine        → RESPONSE_RECEIVED (annulation automatique)
                   ├── réponse automatique    → report
                   ├── réponse ambiguë        → REVIEW_REQUIRED (décision humaine)
                   ├── message sortant récent → SUPERSEDED
                   ├── Graph indisponible     → CHECK_FAILED (nouvelle tentative, jamais d'envoi)
                   └── aucune réponse         → brouillon Claude → action reply_email
                                              → WhatsApp → validation → Outlook → SENT
```

## 1. Table `scheduled_followups` (migration `008_followups`)

| Colonne | Rôle |
|---|---|
| `id`, `created_at`, `updated_at`, `created_by` | identité et traçabilité |
| `kind` | `EXTERNAL_FOLLOWUP` (relance d'un tiers) ou `INTERNAL_REMINDER` (rappel, aucun email) |
| `thread_id`, `email_id` | échange surveillé (conversation Outlook) |
| `recipient` | interlocuteur, **déduit du thread** (jamais inventé) |
| `company_id`, `document_id` | contexte métier éventuel |
| `title`, `reason` | objet du rappel, raison de la relance |
| `execute_at` | échéance (calculée côté serveur) |
| `watch_after` | **ancrage** : seuls les messages postérieurs comptent |
| `status` | machine d'état (ci-dessous) |
| `attempts`, `max_attempts` | tentatives effectuées / autorisées (`settings.followups.maxAttempts`) |
| `action_id` | action à l'origine de la relance (ex. demande de règlement) |
| `generated_action_id` | action `reply_email` créée à l'échéance |
| `last_reply_email_id`, `requires_human_review` | réponse détectée, doute à lever |
| `last_checked_at`, `last_error`, `cancellation_reason` | diagnostic |
| `notification_pending`, `notify_attempts`, `notified_at` | notifications proactives |
| `completed_at`, `cancelled_at` | clôture |

## 2. Machine d'état

| Statut | Signification | Suite |
|---|---|---|
| `SCHEDULED` | en attente de l'échéance | traité par le worker |
| `CHECKING` | vérification en cours (verrou) | repris après 15 min si le process est interrompu |
| `CHECK_FAILED` | Outlook indisponible ou thread introuvable | nouvelle tentative 15 min plus tard |
| `RESPONSE_RECEIVED` | réponse humaine détectée | terminal, aucune relance |
| `REVIEW_REQUIRED` | réponse ambiguë ou relance jugée inutile | décision humaine |
| `WAITING_APPROVAL` | brouillon créé, action en attente de validation | validation WhatsApp ou interface |
| `REMINDED` | rappel interne notifié | boutons Terminé / Reporter |
| `SENT` | relance envoyée | terminal (nouvel ancrage, tentative +1) |
| `CANCELLED`, `SUPERSEDED`, `MAX_ATTEMPTS_REACHED`, `DONE` | terminaux | aucune action future |
| `FAILED` | préparation impossible (Claude indisponible) | récupérable : reporter puis réessayer |

Les transitions passent toutes par `transitionFollowup(id, from, to)` : une mise à jour SQLite conditionnelle. Une relance `SENT` ou `CANCELLED` ne peut plus être exécutée.

## 3. `watch_after` : ce qui compte comme réponse

À la création, l'ancrage est le **dernier message sortant connu du thread** (à défaut, l'email de référence). À l'échéance, EMA n'examine que les messages postérieurs à cet ancrage : une ancienne réponse ne peut jamais annuler une relance récente, et une réponse arrivée juste après l'envoi l'annule. Après une relance envoyée, l'ancrage devient la date de ce nouvel envoi.

## 4. Vérification Outlook obligatoire

À l'échéance, EMA recharge la conversation via Microsoft Graph (`listConversation` puis import des messages inconnus). Microsoft Graph est la source de vérité : le cache SQLite ne suffit jamais.

Si Graph est indisponible, si Outlook n'est pas connecté ou si la conversation est introuvable → `CHECK_FAILED`, nouvelle tentative 15 minutes plus tard, **aucune relance préparée et aucun email envoyé**. EMA ne suppose jamais « pas de réponse ».

## 5. Détection d'une réponse

Règles déterministes (`src/followups/detect.ts`), sans appel au modèle :

- **`HUMAN_REPLY`** : message entrant postérieur à l'ancrage, provenant de l'interlocuteur suivi ou de son domaine, sans motif automatique → relance annulée.
- **`AUTO_REPLY`** : objet, corps ou expéditeur correspondant à un motif connu (absence du bureau, réponse automatique, accusé de réception, non-remise, `no-reply@`, `mailer-daemon@`) → relance **reportée** de `autoReplyPostponeDays` (1 jour par défaut), jamais annulée.
- **`AMBIGUOUS`** : motif automatique détecté mais message long et personnalisé → `REVIEW_REQUIRED`, notification, **aucune relance préparée**.

Un message sortant plus récent que l'ancrage (envoi manuel depuis Outlook) rend la relance obsolète → `SUPERSEDED`.

## 6. Échéances calculées côté serveur

Le modèle n'exprime qu'une intention (`in_days`, `date`, `weekday`, `time`) ; `resolveFollowupDate` calcule l'instant réel dans `settings.company.timezone`, applique `defaultTime` (09:00), décale au lendemain si l'heure est déjà passée et, si `businessDaysOnly` est actif, repousse samedi et dimanche au lundi. Aucun horodatage produit par Claude n'est utilisé.

```json
"followups": {
  "enabled": true,
  "defaultDelayDays": 3,
  "defaultTime": "09:00",
  "maxAttempts": 2,
  "businessDaysOnly": false,
  "requireApproval": true,
  "autoReplyPostponeDays": 1
}
```

`requireApproval` vaut toujours `true` en V1 : le schéma refuse une autre valeur.

## 7. Génération du brouillon

Contexte borné : thread récent (6 messages, encapsulés comme contenu non fiable), dernier message envoyé, raison enregistrée, interlocuteur, société, règles applicables, numéro de tentative. Sortie structurée : `followup_needed`, `summary`, `recipient`, `subject`, `body`, `confidence`, `requires_human_review`, `reason`.

Le ton s'adapte à la tentative (première relance courtoise, seconde plus directe) et n'invente jamais de date, de montant ni d'engagement. Si Claude échoue → `FAILED`, aucune action, message « Impossible de préparer la relance » dans l'interface, relance récupérable.

## 8. Action et validation

Le brouillon devient une action **`reply_email`** classique (aucun chemin d'envoi parallèle), avec `followup_id` et `attempt` dans le payload, `requiresApproval: true`. Une relance sur une demande de règlement conserve le risque **HIGH**.

Le message WhatsApp reprend la carte de validation habituelle avec un en-tête dédié :

```
🔁 EMA — Relance à valider
Contact : Kevin Martin
Sujet : Intervention caisse
Dernier message envoyé : 12/09/2026 09:00
Réponse reçue : Aucune
Tentative : 1 / 2
Relance proposée : "Bonjour Kevin, …"
✅ Valider   ❌ Refuser
```

`update_draft` permet de modifier le texte depuis WhatsApp avant validation (« ajoute que c'est urgent ») ; l'action reste en attente et la modification est tracée. Après validation, l'Action Engine répond dans le thread ; la réconciliation passe la relance à `SENT`, incrémente `attempts` et met à jour `watch_after`. Un refus la passe à `CANCELLED`.

## 9. Report, annulation, maximum de tentatives

- **Report** (interface ou « reporte-la à vendredi ») : nouvelle échéance, retour à `SCHEDULED`, historique conservé, **aucun doublon créé**.
- **Annulation** : `CANCELLED` avec motif, aucune action future.
- **Maximum atteint** : après `maxAttempts` relances envoyées sans réponse → `MAX_ATTEMPTS_REACHED`, notification WhatsApp « Suivi sans réponse » proposant de préparer une nouvelle relance ou d'abandonner. Rien n'est envoyé automatiquement.

## 10. Rappels internes

`kind = INTERNAL_REMINDER` : aucun email, aucun thread requis. À l'échéance, EMA envoie un message WhatsApp « ⏰ EMA — Rappel » avec deux boutons, `Terminé` (`done:<followup_id>`) et `Reporter` (`snooze:<followup_id>`), traités par le routeur WhatsApp et dédoublonnés comme toute interaction Meta.

## 11. Notifications proactives

Le worker peut envoyer un message WhatsApp lorsqu'un rappel arrive à échéance, qu'un suivi reste sans réponse ou qu'une réponse est ambiguë. Une notification déjà envoyée (`notified_at`) n'est jamais renvoyée, même après un redémarrage.

Si Meta refuse le message libre parce que la fenêtre de 24 h est fermée (codes 131047, 131026, 470) :

- un template est configuré (`WHATSAPP_FOLLOWUP_TEMPLATE_NAME`, `WHATSAPP_FOLLOWUP_TEMPLATE_LANG`) → envoi via ce template ;
- sinon → `notification_pending = 1`, affichage dans l'interface, nouvelle tentative par le worker (5 au maximum).

Une notification refusée n'est **jamais** comptée comme envoyée. Template à créer côté Meta, catégorie *utility*, par exemple : « EMA : une relance nécessite votre validation. Ouvrez EMA ou consultez la conversation. »

## 12. Worker et idempotence

La tâche `process_followups` (5 min) s'exécute sous verrou SQLite : réconciliation des relances validées → échéances → notifications en attente. Protections :

- verrou de tâche (`worker_locks`) : une seule exécution simultanée ;
- transition atomique `SCHEDULED → CHECKING` : deux cycles concurrents ne traitent jamais la même relance ;
- une relance restée `CHECKING` plus de 15 minutes (process interrompu) est remise en file, jamais volée à un worker actif ;
- un brouillon déjà créé est **réutilisé** (`draft_reused`) : ni seconde action, ni second email ;
- `webhook_events` dédoublonne les validations et les boutons de rappel ;
- la transition `APPROVED → EXECUTING` de l'Action Engine empêche tout double envoi.

## 13. Pilotage depuis WhatsApp

« Relance Kevin dans 3 jours », « rappelle-moi lundi de signer le devis ABC », « qui dois-je relancer aujourd'hui ? », « prépare le premier », « reporte-la à vendredi », « annule la relance ABC ». Outils exposés : `list_followups`, `schedule_followup`, `postpone_followup`, `cancel_followup`, `complete_reminder`, `prepare_followup_now`, `check_reply_received`. Les listes sont numérotées et mémorisées comme références multi-tours (phase 6), donc « le premier » désigne la relance réelle, sans nouvelle recherche approximative.

`prepare_followup_now` applique la même règle que le worker : vérification Outlook d'abord, et rien n'est préparé si une réponse est arrivée.

## 14. Interface

**Relances** : sections À traiter, En attente de validation, Aujourd'hui, À venir, Envoyées/terminées, Annulées. Pour chaque ligne : type, contact, objet, échéance, tentative, statut, dernière réponse, et les actions Voir le thread, Voir la relance, Préparer maintenant, Reporter, Annuler, Terminé (rappels).

**Aujourd'hui** : relances du jour, relances à valider, réponses reçues ayant annulé une relance, suivis sans réponse, rappels internes.

## 15. Historique

`followup.created`, `followup.checked`, `followup.check_failed`, `followup.response_received`, `followup.auto_reply_detected`, `followup.review_required`, `followup.superseded`, `followup.due`, `followup.draft_created`, `followup.approval_requested`, `followup.sent`, `followup.snoozed`, `followup.cancelled`, `followup.max_attempts`, `followup.notified`, `followup.notification_pending`, `followup.failed`, `followup.done`. Le contenu des emails n'y est jamais recopié.

## 16. Limites connues

- Pas de jours fériés : `businessDaysOnly` ne gère que le week-end.
- La classification d'une réponse est déterministe (motifs connus) : un auto-répondeur exotique peut être vu comme une réponse humaine, ce qui annule la relance (comportement prudent : jamais d'envoi en trop).
- Après une relance envoyée, aucune relance suivante n'est programmée automatiquement : l'utilisateur ou une règle doit la demander.
- Une seule relance active par échéance ; pas de récurrence.
- Les notifications proactives dépendent de la fenêtre WhatsApp de 24 h et du template configuré côté Meta.
