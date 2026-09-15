# Document Engine — factures, demandes de paiement, acomptes — Phase 4

## 1. Rôle

Lire les pièces jointes PDF, les classer, en extraire les données de façon structurée, rattacher la société, appliquer les règles de routage et proposer **une action email administrative** soumise à validation. EMA ne se connecte à aucune banque, n'initie aucun paiement, ne modifie aucun RIB et ne conclut jamais qu'une facture est payée.

```
email NEW → analyse email (phase 2)
   → pièces jointes PDF : ensureDocumentText (pdf-parse) → classification heuristique
   → Claude (sortie structurée `documentExtractionSchema`) → garde-fous déterministes → doublons
   → documents (données dénormalisées + JSON complet) + history
   → proposeFinancialActions : règles → forward_email | payment_request | deposit_request (WAITING_APPROVAL)
   → WhatsApp (phase 3) → validation → exécuteur Outlook → COMPLETED
```

## 2. Extraction de texte (`src/documents/extract-text.ts`)

- Librairie : **pdf-parse v2** (pdf.js en TypeScript pur, Node et navigateur). Aucun script embarqué n'est exécuté ; seul le texte est lu.
- Vérifications avant lecture : MIME `application/pdf`, taille ≤ `ATTACHMENT_MAX_MB`, signature `%PDF-`, fichier présent dans `private/`.
- Résultat conservé une seule fois dans `documents.extracted_text` (≤ 60 000 caractères), `text_pages`, `text_status` : `extracted` | `no_text` | `unsupported` | `error`.
- **PDF sans texte** (scan) : moins de 40 caractères utiles → `no_text`, `requires_human_review = 1`, aucun appel Claude, rien n'est inventé. L'architecture accepte un OCR ultérieur (il suffit d'alimenter `extracted_text` et de passer `text_status` à `extracted`) ; aucune infrastructure OCR n'est ajoutée en phase 4.

## 3. Classification (`src/documents/classify.ts` + Claude)

Types stricts : `INVOICE`, `CREDIT_NOTE`, `QUOTE`, `PAYMENT_PROOF`, `BANK_DETAILS`, `PURCHASE_ORDER`, `CONTRACT`, `OTHER`, `UNKNOWN`.

Une heuristique (nom de fichier + texte) fournit un indice au modèle et sert de secours ; la classification finale vient de la sortie structurée de Claude, validée par zod. Un IBAN sur une facture ne fait pas un `BANK_DETAILS`. Détection locale : `IBAN_REGEX` (présence + 4 derniers caractères) et `BANK_CHANGE_REGEX` (« nouveau RIB », « changement de coordonnées bancaires », « new bank details »…).

## 4. Schéma d'extraction (`src/documents/types.ts`)

`document_type`, `summary`, `supplier_name`, `supplier_email`, `invoice_number`, `invoice_date`, `due_date` (YYYY-MM-DD), `purchase_order_number`, `customer_company_name`, `company_id`, `amount_excl_tax`, `vat_amount`, `amount_incl_tax`, `currency`, `deposit_amount`, `deposit_percent`, `total_amount`, `iban_present`, `iban_last4`, `bank_details_change_suspected`, `payment_reference`, `document_confidence` (0-1), `requires_human_review`, `warnings[]`, `injection_suspected`. Toute valeur absente est `null`.

## 5. Garde-fous déterministes (`src/documents/invoice.ts`)

| Contrôle | Effet |
|---|---|
| Montant négatif ou non fini | valeur ignorée (`null`), revue humaine |
| HT + TVA ≠ TTC (tolérance 2 centimes ou 1 %) | avertissement « Montants incohérents », revue humaine |
| TTC < HT | avertissement, revue humaine |
| Aucun montant / numéro absent (facture, avoir) | avertissement, revue humaine — jamais reconstruit |
| `company_id` hors `config/companies.json` | `null`, revue humaine |
| Nom client correspondant à plusieurs sociétés | `company_id = null`, revue humaine |
| Nom client correspondant à une seule société (nom ou alias) | rattachement |
| IBAN trouvé dans le texte | `iban_present = true` même si le modèle l'a manqué |
| Changement de RIB (texte ou modèle) | `bank_details_change_suspected = true`, revue humaine, **aucune action financière** |
| `BANK_DETAILS` | revue humaine, aucune action |
| `PAYMENT_PROOF` | avertissement « ne vaut pas confirmation de règlement » |
| Confiance < `settings.analysis.reviewThreshold` | revue humaine |
| Injection (heuristique ou modèle) | `injection_suspected`, revue humaine, aucune action |

## 6. Doublons (`detectDuplicates`)

Candidats : même empreinte SHA-256, ou même fournisseur + même numéro, ou même fournisseur + même montant TTC. Signalé (`possible_duplicate = 1`, `duplicate_of` = liste avec raisons, revue humaine, historique `document.duplicate_suspected`) si :
- fichier identique (empreinte), **ou**
- même fournisseur et même numéro, **ou**
- même fournisseur, même montant TTC **et** même date de facture.

Fournisseur + montant seuls (facture récurrente) ne suffisent jamais. Rien n'est supprimé ; les documents similaires sont affichés dans le détail.

## 7. Routage déterministe (`src/documents/routing.ts`)

Le destinataire ne vient **jamais** du modèle :
- **Facture** (catégorie email `INVOICE` ou document `INVOICE`/`CREDIT_NOTE`) : `evaluateRules()` avec fournisseur, expéditeur, objet, société, montant → première règle `forward` → action `forward_email` (destinataire de la règle, commentaire généré : « Pouvez-vous prendre en charge cette facture ABC n° F… (1 845,20 € TTC), échéance … ? »). Sans règle : aucune action, historique `action.blocked`, revue humaine.
- **Demande de paiement / d'acompte** (`PAYMENT_REQUEST`, `DEPOSIT_REQUEST`) : destinataire = règle `forward` de la catégorie, sinon contact interne dont le rôle contient comptabilité / paiement / finance / trésorerie / règlement. Action `payment_request` ou `deposit_request` = **`send_email` interne**, risque **HIGH** (jamais abaissable : `resolveRiskLevel` ne descend pas sous le défaut, `requiresApproval` explicite), objet « Demande de règlement — Fournisseur — facture F… », corps « Peux-tu procéder au règlement de la facture … d'un montant de … TTC ? Échéance : … ». Sans contact : aucune action.
- Bloquants absolus : injection suspectée, changement de RIB ou document `BANK_DETAILS`, doublon potentiel, règle `ignore`. Une seule action financière active par email (réanalyse sans doublon).
- Le transfert Graph (`POST /me/messages/{id}/forward`) conserve l'email original et ses pièces jointes.

## 8. WhatsApp

Messages enrichis (phase 3 réutilisée) : `📄 EMA — Facture à traiter` (fournisseur, facture, montant, échéance, société, action proposée) et `💳 EMA — Demande de paiement` avec la note « ⚠️ EMA n'effectuera aucun paiement bancaire ». Doublon potentiel et changement de RIB sont signalés dans le message.

## 9. Sécurité

- Texte des documents encapsulé dans `<untrusted_document_content source="document" id="…">` (`wrapUntrusted`, `tagFor`), balises imitées neutralisées ; même règle absolue que pour les emails : jamais une instruction.
- Le prompt document (`src/agent/prompts/analyze-document.md`) rappelle qu'un document qui demande d'approuver, payer ou changer un RIB n'exprime qu'une demande.
- Le chemin `private/` n'est jamais renvoyé par l'API (`/api/documents/{id}` retire `original_path`, `signed_path`, `extracted_text`) ; le PDF est servi par `/api/documents/{id}/file` après authentification.

## 10. Worker

- `scan_mailbox` → `analyze_emails` : l'analyse d'un email déclenche l'analyse de ses PDF puis le routage ; une erreur documentaire est journalisée (`document.analysis_failed`) sans bloquer l'email.
- `analyze_documents` (5 min) : rattrapage des PDF jamais analysés (téléchargés à la demande, analyse interrompue).

## 11. Interface

- **Documents** : onglets Factures / avoirs, Devis, Justificatifs, À vérifier, Autres, Tous ; recherche ; type, fichier, email source, fournisseur, société, numéro, montant, échéance, date, confiance, statut, doublon, changement RIB, PDF sans texte.
- **Détail d'un document** : informations extraites, avertissements, email source, règles appliquées et action proposée, historique, bouton Réanalyser, ouverture du PDF.
- **Détail d'un email** : pièces jointes analysées (type, fournisseur, numéro, montant, échéance, société, confiance).
- **Aujourd'hui** : factures reçues, demandes de paiement / acomptes, documents à vérifier, doublons potentiels, alerte changement de RIB, actions financières à valider.
- **À valider** : détails facture sur l'action, note « aucun paiement bancaire ».
- **Chat** : outils de lecture `search_documents`, `get_document`, `list_pending_actions` ; « Paye cette facture » → réponse explicite qu'aucune action bancaire n'existe.

## 12. Historique

`document.text_extracted`, `document.no_text`, `document.text_unsupported`, `document.analyzed`, `document.analysis_failed`, `document.duplicate_suspected`, `document.bank_change_suspected`, `rule.applied`, `action.blocked`, puis les événements d'action et de validation de la phase 3. Le texte du PDF n'est jamais recopié dans l'historique.

## 13. Limitations

- Pas d'OCR : un PDF scanné est signalé pour lecture humaine.
- Les montants sont pris tels qu'écrits ; les factures multi-devises ou multi-pages complexes peuvent nécessiter une vérification.
- Les justificatifs de paiement sont archivés et décrits, jamais rapprochés automatiquement d'une facture.
- Les devis sont classés (`QUOTE`) mais le workflow de signature arrive en phase 5.
