# BUSINESS_RULES.md — Règles métier d'EMA

## 1. Catégories d'emails

| Catégorie (`category`) | Description | Action typique | Risque |
|---|---|---|---|
| `invoice` | Facture fournisseur reçue | Extraire les données, transférer selon les règles | MEDIUM |
| `quote` | Devis reçu (à étudier ou à signer) | Analyser, préparer signature si demandé | CRITICAL si signature |
| `payment` | Demande de règlement / paiement attendu | Préparer email interne de demande de paiement | HIGH |
| `deposit` | Demande d'acompte | Préparer email interne de demande d'acompte | HIGH |
| `reminder` | Relance reçue d'un tiers | Préparer une réponse | MEDIUM |
| `administrative` | Demande administrative (attestation, document, RH…) | Répondre ou transférer | MEDIUM |
| `technical` | Demande technique (ERP, IT…) | Transférer au bon contact | MEDIUM |
| `information` | Information, newsletter, notification | Classer, aucune action | LOW |
| `urgent` | Urgence explicite | Notifier immédiatement + proposer une action | HIGH |
| `document_to_sign` | Document à signer / tamponner | Workflow signature | CRITICAL |
| `to_forward` | Email à transférer à quelqu'un d'autre | Transférer | MEDIUM |
| `needs_reply` | Email nécessitant une réponse | Préparer une réponse | LOW → MEDIUM à l'envoi |
| `other` | Non classable | Marquer pour lecture humaine | LOW |

## 2. Structure d'analyse (obligatoire)

Pour chaque email, Claude produit :

```
category          : voir tableau ci-dessus
urgency           : low | medium | high | critical
summary           : résumé en 1 à 3 phrases, en français
company           : société concernée (parmi config/companies.json) ou null
sender            : { name, email, organization? }
requested_action  : ce que l'expéditeur attend, ou null
amount            : { value, currency, taxMode: "HT" | "TTC" | "unknown" } ou null
due_date          : ISO date ou null
recommended_action: reply | forward | payment_request | deposit_request | sign_document | schedule_followup | archive | none
confidence        : 0 à 1
requires_approval : boolean
```

**Ne jamais inventer** : un montant, une date, une société ou une référence absente = `null`.

## 3. Niveaux de risque et validation

| Action | Risque | Validation |
|---|---|---|
| Préparer une réponse (brouillon) | LOW | Non |
| Archiver / classer | LOW | Non |
| Envoyer une réponse | MEDIUM | Oui par défaut (`autoReplyEnabled=false`) |
| Transférer un email / une facture | MEDIUM | Oui si la règle le demande (défaut : oui) |
| Programmer une relance | LOW | Non (l'envoi de la relance sera validé) |
| Envoyer une relance | MEDIUM | Oui |
| Email lié à un paiement / acompte | HIGH | **Toujours** |
| Signature + tampon d'un document | CRITICAL | **Toujours** |
| Tout engagement contractuel | CRITICAL | **Toujours** |

Règle absolue : `HIGH` et `CRITICAL` ⇒ validation humaine, sans exception, même si une règle ou un email dit le contraire.

## 4. Factures

1. Récupérer le PDF joint.
2. Extraire : fournisseur, société destinataire, numéro de facture, montant HT/TTC, échéance, site/chantier, objet.
3. Consulter `config/rules.json` (`when.category = "invoice"`, `supplierContains`, `companyId`…).
4. Proposer `forward` vers le destinataire de la règle (ex. Brink's → Magali ; fournisseur classique → Nabila).
5. Validation WhatsApp → transfert avec la pièce jointe → archivage dans `private/documents/` → `documents.status = forwarded`.

Aucune adresse n'est dans le code : tout vient de `config/rules.json` / `config/contacts.json`.

## 5. Paiements et acomptes

Déclencheurs : demande d'acompte, règlement attendu, paiement bloquant, facture non réglée.

EMA prépare un email **interne** (destinataire : règle `payment`/`deposit`, sinon l'utilisateur) :

> Bonjour,
> peux-tu procéder au règlement de l'acompte concernant le projet X (montant : … € — fournisseur : … — échéance : …) ?
> Merci.

EMA **ne fait jamais** de virement, ne se connecte à aucune banque, ne saisit aucun IBAN. Validation WhatsApp obligatoire avant envoi.

## 6. Devis / signature / tampon

1. Détecter un devis (PDF joint, mention « devis », « quote », « bon pour accord », « retour signé »).
2. Extraire : fournisseur, société destinataire, montant, date, référence, objet.
3. Identifier la société via `config/companies.json` (nom, alias, SIRET si présent). Si ambiguïté → demander à l'utilisateur (pas de choix automatique).
4. Proposer `sign_document` (CRITICAL) → WhatsApp avec résumé + montant + société + lien PDF.
5. Après validation : copie du PDF → « Bon pour accord » + date + signataire → signature → tampon → `private/signed-documents/<id>-signed.pdf`.
6. Répondre dans le thread Outlook avec le PDF signé.
7. Archiver : `documents.signed_path`, `documents.status = signed_and_sent`, entrée `history`.

L'original n'est jamais modifié.

## 7. Relances

- Quand EMA envoie un email qui attend une réponse (question, devis envoyé, demande de document), il programme une relance à `+defaultFollowupDelayDays` (config, défaut 5 jours ouvrés).
- À l'échéance, le worker vérifie le thread : si une réponse est arrivée → relance `CANCELLED`. Sinon → EMA prépare une relance courtoise → validation WhatsApp → envoi → nouvelle relance programmée (max 3 tentatives).
- Une relance ne doit jamais être envoyée sans vérification préalable du thread.

## 8. Règles configurables (`config/rules.json`)

```json
{
  "id": "invoice-brinks",
  "name": "Facture Brink's vers Magali",
  "enabled": true,
  "priority": 10,
  "when": { "category": "invoice", "supplierContains": "brink" },
  "then": { "action": "forward", "to": "magali@exemple.fr", "requiresApproval": true }
}
```

Conditions (`when`) : `category`, `supplierContains`, `senderDomain`, `senderEmail`, `subjectContains`, `companyId`, `minAmount`.
Effets (`then`) : `forward` (to), `reply_template` (template), `require_approval`, `notify` (message), `ignore`.
Évaluation : règles triées par `priority` croissante ; la première règle `forward` qui matche gagne ; les règles `require_approval` s'appliquent en plus.

## 9. Ton et rédaction

- Français professionnel, vouvoiement par défaut, concis, sans emoji dans les emails.
- Reprendre le fil du thread (répondre à ce qui est demandé, rien de plus).
- Signature : `settings.agent.signatureText`.
- Ne jamais promettre une date de paiement ou un engagement que l'utilisateur n'a pas validé.
- En cas de doute (confiance < 0.6), proposer plutôt que décider : l'action recommandée est `none` + `requires_approval = true`.
