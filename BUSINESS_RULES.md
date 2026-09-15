# BUSINESS_RULES.md — Règles métier d'EMA

## 1. Catégories d'emails

| Catégorie (`category`) | Description | Action typique | Risque |
|---|---|---|---|
| `INVOICE` | Facture fournisseur reçue | Extraire les données, transférer selon les règles | MEDIUM |
| `QUOTE` | Devis reçu (à étudier) | Analyser, préparer signature si demandé | CRITICAL si signature |
| `PAYMENT_REQUEST` | Règlement attendu, facture non réglée | Préparer email interne de demande de paiement | HIGH |
| `DEPOSIT_REQUEST` | Demande d'acompte | Préparer email interne de demande d'acompte | HIGH |
| `SUPPLIER_FOLLOWUP` | Relance reçue d'un tiers | Préparer une réponse | MEDIUM |
| `ADMIN_REQUEST` | Demande administrative (attestation, document, RH…) | Répondre ou transférer | MEDIUM |
| `TECHNICAL_REQUEST` | Demande technique (ERP, IT…) | Transférer au bon contact | MEDIUM |
| `INFORMATION` | Information, newsletter, notification | Classer, aucune action | LOW |
| `URGENT` | Urgence explicite | Notifier immédiatement + proposer une action | HIGH |
| `DOCUMENT_TO_SIGN` | Document ou devis à retourner signé | Workflow signature | CRITICAL |
| `FOLLOWUP_REQUIRED` | L'expéditeur attend un retour de notre part | Préparer une réponse | LOW → MEDIUM à l'envoi |
| `OTHER` | Non classable | Marquer pour lecture humaine | LOW |

Les anciennes valeurs minuscules de la phase 0 (`invoice`, `payment`…) restent acceptées dans `config/rules.json` et sont converties automatiquement.

## 2. Structure d'analyse (obligatoire)

Pour chaque email, Claude produit (schéma zod strict, `src/agent/schemas.ts`) :

```
category              : voir tableau ci-dessus
urgency               : LOW | NORMAL | HIGH | CRITICAL
summary               : synthèse courte en français
sender                : { name, email, organization }
company_id            : id de config/companies.json, ou null (absent ou ambigu)
company_name          : nom vu dans l'email, ou null
requested_action      : ce que l'expéditeur attend, ou null
amount / currency     : montant explicite et devise, ou null
due_date              : YYYY-MM-DD ou null
needs_reply           : boolean
recommended_action    : reply | forward | payment_request | deposit_request | sign_document | schedule_followup | archive | none
confidence            : 0 à 1
requires_human_review : boolean
reply_draft           : brouillon complet si needs_reply, sinon null
reasoning_summary     : justification courte (pas de raisonnement détaillé)
injection_suspected   : boolean
```

**Ne jamais inventer** : montant, facture, référence, société, identité, destinataire, date, échéance, décision, contenu d'une pièce jointe = `null` si absent. Plusieurs sociétés possibles → `company_id = null` et `requires_human_review = true`. Confiance insuffisante → `requires_human_review = true`. Détails et garde-fous : `docs/analysis.md`.

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

1. Récupérer le PDF joint (phase 1), extraire son texte (pdf-parse), le classer (`INVOICE`, `CREDIT_NOTE`…).
2. Extraire : fournisseur, société destinataire, numéro, date, montants HT / TVA / TTC, échéance, bon de commande, IBAN (présence et 4 derniers caractères), référence de paiement. Toute donnée absente = `null`.
3. Garde-fous en code : cohérence HT + TVA = TTC, société vérifiée contre `config/companies.json`, doublons potentiels (empreinte, fournisseur + numéro, fournisseur + montant + date), changement de RIB.
4. Consulter `config/rules.json` (`when.category = "INVOICE"`, `supplierContains`, `companyId`…) : la **première règle `forward`** donne le destinataire (ex. Brink's → Magali ; fournisseur classique → Nabila).
5. Proposer `forward_email` (email original + pièces jointes + message d'accompagnement) → validation WhatsApp → transfert → archivage.

Sans règle, sans destinataire fiable, en cas de doublon potentiel, de changement de RIB ou d'instruction suspecte : **aucune action**, vérification humaine. Aucune adresse n'est dans le code ni inventée par le modèle. Détails : `docs/documents.md`.

## 5. Paiements et acomptes

Déclencheurs : `PAYMENT_REQUEST` (facture impayée, règlement attendu, paiement bloquant), `DEPOSIT_REQUEST` (acompte).

EMA prépare un email **interne** (`send_email`, risque **HIGH**, jamais abaissable) au destinataire issu d'une règle `forward` de la catégorie ou d'un contact interne au rôle comptabilité / paiement / finance :

> Objet : Demande de règlement — Fournisseur ABC — facture F1234
>
> Bonjour,
> Peux-tu procéder au règlement de la facture ABC F1234 d'un montant de 1 845,20 € TTC ?
> Échéance : 30/09/2026.
> Merci.

Pour un acompte : montant, pourcentage et total si présents. EMA **ne fait jamais** de virement, ne se connecte à aucune banque, ne saisit aucun IBAN, ne valide aucune dépense et ne considère jamais une facture comme payée (un justificatif de paiement reçu est décrit comme « document présenté comme justificatif »). Un changement de coordonnées bancaires détecté bloque toute action financière et affiche « ⚠️ Changement de coordonnées bancaires détecté — vérification humaine requise ». Validation WhatsApp obligatoire avant tout envoi.

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
  "when": { "category": "INVOICE", "supplierContains": "brink" },
  "then": { "action": "forward", "to": "magali@exemple.fr", "requiresApproval": true }
}
```

Conditions (`when`) : `category`, `supplierContains` (organisation détectée, adresse ou objet), `senderDomain`, `senderEmail`, `subjectContains`, `companyId`, `minAmount`.
Effets (`then`) : `forward` (to), `reply_template` (template), `require_approval`, `notify` (message), `ignore`.
Évaluation (`src/agent/rules.ts`, en code, jamais par le modèle) : règles triées par `priority` croissante ; la première règle `forward` qui matche décide du destinataire ; les règles `require_approval` s'appliquent en plus. Claude reçoit uniquement les règles compatibles avec l'email (expéditeur, domaine, objet) pour comprendre le contexte.

## 9. Ton et rédaction

- Français professionnel, vouvoiement par défaut, concis, sans emoji dans les emails.
- Reprendre le fil du thread (répondre à ce qui est demandé, rien de plus).
- Signature : `settings.agent.signatureText`.
- Ne jamais promettre une date de paiement ou un engagement que l'utilisateur n'a pas validé.
- En cas de doute (confiance < `settings.analysis.reviewThreshold`, 0,60 par défaut), proposer plutôt que décider : `requires_human_review = true`. Entre 0,60 et 0,85 (`reliableThreshold`), l'interface affiche un avertissement.
- Si une donnée essentielle manque pour répondre, le brouillon demande une précision au lieu de l'inventer.
