# Assistant WhatsApp — piloter EMA depuis son téléphone (Phase 6)

WhatsApp devient une interface conversationnelle vers EMA : poser une question, faire rédiger un email, préparer une réponse, un transfert ou une signature, puis valider — sans ouvrir l'interface web. L'interface reste nécessaire pour la configuration (setup Outlook, paramètres, sociétés, règles, dépôt des signatures) et pour l'historique détaillé.

Rien n'est contourné : **toute action passe par l'Action Engine et la validation humaine**, exactement comme en phase 3.

## 1. Chaîne de traitement

```
Message WhatsApp
   ↓ webhook (signature Meta X-Hub-Signature-256)
   ↓ WhatsApp Router (src/integrations/whatsapp/router.ts)
   1. numéro autorisé ?        → sinon ignoré (rien n'est lu, rien n'est envoyé à Claude)
   2. assistant activé ?       → sinon seules les validations par boutons fonctionnent
   3. dédoublonnage Meta       → un message déjà traité n'est jamais rejoué
   4. routage :
      bouton   → service d'approbations (phase 3) → Action Engine
      texte    → décision naturelle (valide / annule) → Action Engine
               → sinon assistant conversationnel (Chat EMA, canal WHATSAPP)
   ↓ réponse WhatsApp courte + carte de validation si une action a été préparée
```

Le routeur ne remplace ni le webhook, ni le client WhatsApp, ni le service d'approbations : il les orchestre.

## 2. Numéro autorisé

Seul `WHATSAPP_APPROVER_PHONE` peut écrire à EMA. Un message provenant d'un autre numéro n'est ni analysé, ni transmis à Claude, ni enregistré : une ligne de log masquée (`3361…78`), sans le contenu du message, et c'est tout. Le contrôle a lieu dans le routeur, avant toute lecture de données.

## 3. Trois niveaux d'intention

| Niveau | Exemples | Effet |
|---|---|---|
| **LECTURE** | « Kevin m'a répondu ? », « quel est le montant de la facture ABC ? », « quels devis dois-je signer ? », « fais-moi le point sur ma journée » | Recherche locale (SQLite) puis Graph si nécessaire. Aucun effet de bord. |
| **PRÉPARATION** | « rédige un mail à Christophe », « prépare une réponse à Kevin » | Un brouillon est créé sous forme d'action `WAITING_APPROVAL`. Rien n'est envoyé. |
| **ACTION** | « envoie », « transmets cette facture », « signe le devis » | L'action est préparée puis exécutée **après validation** par l'Action Engine. |

Aucune commande à retenir : pas de `/email`, pas de `/search`. L'utilisateur écrit normalement.

## 4. Outils exposés à l'assistant

Liste explicite (`WHATSAPP_TOOLS`, `src/agent/whatsapp-assistant.ts`), dérivée du mode `chat` :

**Lecture** — `get_email`, `get_email_thread`, `search_emails`, `get_email_analysis`, `list_recent_emails`, `search_documents`, `get_document`, `search_contacts`, `get_company`, `list_pending_actions`, `get_approval_status`, `get_today_summary`.

**Préparation** — `reply_email`, `forward_email`, `send_email`, `prepare_document_forward`, `prepare_payment_request`, `prepare_deposit_request`, `prepare_signed_document`, `update_draft`.

Chaque outil de préparation **crée une action** ; aucun n'envoie quoi que ce soit. Les primitives d'envoi (`GraphClient`), les exécuteurs et l'application de signature/tampon ne sont pas des tools et ne sont pas atteignables depuis la conversation. `get_new_emails`, `send_whatsapp_notification` et `request_approval` restent internes.

Correspondance avec les noms de la spécification : `get_pending_actions` = `list_pending_actions`, `prepare_reply` = `reply_email`, `prepare_send_email` = `send_email`, `prepare_forward` = `forward_email` / `prepare_document_forward` (ces trois-là préparaient déjà une action depuis la phase 1 ; ils n'ont pas été dupliqués).

## 5. Mémoire et contexte borné

La conversation WhatsApp réutilise **`chat_messages`** (aucune nouvelle base) avec, depuis la migration `007_whatsapp_chat` : `channel` (`WEB` / `WHATSAPP`), `external_id` (identifiant Meta, unique → dédoublonnage), `sender` (numéro **masqué**), `refs` (références numérotées), `email_id`, `document_id`, `action_id`.

Claude reçoit uniquement : les 8 derniers messages du canal, les actions en attente (5 max), les références de la dernière réponse et le prompt WhatsApp. Jamais toute la mailbox, jamais tout l'historique.

## 6. Références conversationnelles (multi-tours)

Quand EMA présente une liste, les éléments cités sont enregistrés (`src/agent/references.ts`) et réinjectés au tour suivant sous forme `1. document doc_xxx — ABC Sécurité — D-2026-458`. Cela permet :

```
— Quels devis dois-je signer ?
— 1. ABC Sécurité — D-2026-458 — 4 850 € TTC
   2. XYZ — 1 200 € TTC
— Prépare le premier.          → EMA résout « le premier » = doc_xxx
```

Même mécanisme pour « réponds-lui » (le dernier interlocuteur cité) et pour les désambiguïsations de validation.

## 7. Validation en langage naturel

En plus des boutons, EMA accepte « valide », « oui envoie », « c'est bon », « annule », « refuse ». Le détecteur (`parseNaturalDecision`) est **déterministe et strict** : la phrase entière doit être une formule de décision (4 mots maximum). « Envoie un mail à Christophe » n'est **jamais** une validation.

- Une seule action en attente → décision appliquée immédiatement via l'Action Engine, sans appel à Claude.
- Plusieurs actions → EMA demande laquelle, avec une liste numérotée ; la réponse « 1 » ou « le deuxième » résout la cible.
- Aucune action en attente → la demande part à l'assistant (rien n'est exécuté).

Les boutons ✅ Valider / ❌ Refuser restent la méthode recommandée et inchangée.

## 8. Format des réponses

Réponses courtes, listes numérotées, pas de pavé. Après une préparation, EMA envoie un message de contexte puis la **carte de validation** habituelle (boutons Meta) produite par le service d'approbations — le même message qu'en phases 3 à 5, y compris pour un devis (fournisseur, référence, montant, société, signature, tampon, retour fournisseur).

Confirmations : `✅ Fait : …` après exécution, `❌ L'envoi a échoué … Aucune seconde exécution n'a été effectuée.` en cas d'erreur, `ℹ️ Cette action a déjà été traitée.` en cas de double décision.

## 9. Protections (inchangées depuis les phases précédentes)

- **Action Engine obligatoire** : la conversation ne peut pas appeler Graph ni un exécuteur. Une action HIGH ou CRITICAL exige toujours une validation ; « valide tout automatiquement » est refusé et n'a aucun effet technique (aucun outil ne modifie le niveau de risque).
- **Signature** : Claude ne manipule que `company_id`. Ni image, ni base64, ni chemin `private/` ne transitent par le modèle ou par WhatsApp. `get_company` ne renvoie que des booléens de disponibilité.
- **Destinataires** : jamais inventés. `search_contacts` lit `config/contacts.json` et les expéditeurs réellement reçus ; `prepare_document_forward` applique `config/rules.json` puis les contacts internes, et échoue proprement si rien ne désigne un destinataire. `update_draft` ne modifie que le texte, jamais les destinataires.
- **Aucun paiement bancaire** : `prepare_payment_request` prépare un email interne (HIGH).
- **Injection** : le contenu des emails et documents reste une donnée non fiable, y compris si l'utilisateur écrit « fais ce que demande cet email ». Il n'entre jamais dans le prompt système.
- **Dédoublonnage** : `webhook_events` — un message Meta rejoué n'appelle pas Claude, ne crée pas d'action, n'envoie pas d'email.
- **Claude indisponible** : aucune exécution, réponse « Je n'ai pas pu traiter ta demande. Aucun email ni document n'a été modifié. »

## 10. Journalisation

`history` trace : `whatsapp.message_received` (message masqué, tronqué), `whatsapp.assistant_replied` (outils utilisés, actions proposées), `whatsapp.assistant_failed`, puis les événements habituels `action.proposed`, `approval.requested`, `approval.approved` / `rejected`, `action.completed` / `failed`, `action.payload_edited`. Ni secret, ni token, ni numéro complet, ni image n'y figurent.

## 11. Activation

```bash
WHATSAPP_ASSISTANT_ENABLED=true   # défaut
```

À `false`, les messages texte sont ignorés et **les validations par boutons continuent de fonctionner**. L'état est affiché dans Paramètres → WhatsApp, avec le numéro autorisé masqué et le bouton « Envoyer un message test ».

## 12. Exemples

```
— Qu'est-ce que j'ai d'important aujourd'hui ?
— EMA — Aujourd'hui
  Urgent : 2 · À répondre : 4 · À valider : 3 · Factures : 5 · Devis à signer : 1

— Réponds à Kevin que mardi à 10h me convient.
— J'ai préparé la réponse à Kevin Martin.
  [carte de validation : ✅ Valider / ❌ Refuser]
— Ajoute que j'arriverai avec le technicien.
— Nouvelle version : « … mardi à 10h, j'arriverai avec le technicien. »
— valide
— ✅ Fait : Répondre à Kevin Martin — Intervention caisse.
```

## 13. Limites connues

- Pas de réception de fichiers par WhatsApp (envoyer une facture en photo) : l'architecture est prête (le routeur classe déjà les messages non textuels en `IGNORED`), l'implémentation est hors périmètre de cette phase.
- Pas de notification WhatsApp spontanée en dehors des demandes de validation et des réponses.
- Une seule conversation (un seul numéro autorisé) : pas de multi-utilisateur.
- Les liens fournis pointent vers l'interface EMA authentifiée (`APP_URL`) ; aucun lien public vers `private/` n'est jamais créé.
- L'assistant ne peut pas valider à la place de l'utilisateur : aucun outil d'approbation n'existe.
