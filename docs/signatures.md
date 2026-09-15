# Devis, bon pour accord, signature graphique et tampon (Phase 5)

Ce document décrit comment EMA traite un **devis** reçu par email : analyse, association à une société, préparation d'une action `sign_document`, validation humaine, génération d'une **copie signée** (signature graphique enregistrée + tampon) et retour au fournisseur dans le thread Outlook.

> **Vocabulaire.** EMA appose une *signature enregistrée* (image PNG fournie par le client) et un *tampon* sur une copie du PDF. Ce n'est **pas** une signature électronique qualifiée, ni une signature eIDAS, ni une signature cryptographique. Aucun texte d'EMA ne doit le présenter ainsi.

## 1. Vue d'ensemble

```
Email + PDF ──► Document Engine (extraction texte, classification, Claude : schéma QUOTE)
            ──► garde-fous déterministes (type, société, montants, validité)
            ──► prepareQuoteSignature() ──► action sign_document (CRITICAL, WAITING_APPROVAL)
            ──► WhatsApp « 📄 EMA — Devis à signer » (VALIDER / REFUSER) ou page À valider
            ──► validation ──► exécuteur sign_document :
                   createSignedCopy() (pdf-lib, assets privés) ──► reply Outlook avec le SEUL PDF signé
                   ──► documents.status = signed_and_sent, history
```

Seul le type `QUOTE` entre dans ce workflow. `CONTRACT`, `BANK_DETAILS`, `INVOICE`, `CREDIT_NOTE`, `PAYMENT_PROOF`, `PURCHASE_ORDER`, `OTHER`, `UNKNOWN` ne sont **jamais** signés automatiquement. Un contrat détecté passe en `requires_human_review` avec le message « Document contractuel détecté — traitement manuel requis. ».

## 2. Analyse d'un devis (schéma QUOTE)

Le schéma d'extraction (`src/documents/types.ts`, `documentExtractionSchema`) est commun à tous les documents et a été étendu pour les devis :

| Champ | Contenu | Règle |
|---|---|---|
| `document_type` | `QUOTE` | obligatoire pour toute signature |
| `supplier_name`, `supplier_email` | émetteur du devis | `null` si absent |
| `quote_number` | référence du devis | un `invoice_number` d'un devis est reclassé ici |
| `invoice_date` | date du devis | `YYYY-MM-DD` ou `null` |
| `valid_until` | date de validité | `YYYY-MM-DD` ou `null` |
| `subject` | objet (≤ 300 caractères) | `null` si absent |
| `amount_excl_tax`, `vat_amount`, `amount_incl_tax`, `currency` | montants | jamais reconstruits ; `null` si absents |
| `deposit_amount`, `deposit_percent` | acompte demandé | `null` si absent |
| `payment_terms`, `delivery_or_service_date` | conditions | `null` si absent |
| `signature_requested` | le document demande un retour signé | booléen |
| `customer_company_name`, `company_id` | société destinataire | `company_id` vérifié côté serveur |
| `document_confidence`, `requires_human_review`, `warnings`, `injection_suspected` | qualité | voir garde-fous |

Le texte du PDF est transmis à Claude dans `<untrusted_document_content>` (`src/security/untrusted.ts`). Claude ne reçoit jamais le fichier binaire, ni les chemins réels, ni les images.

## 3. Garde-fous déterministes (`src/documents/invoice.ts`, `applyDocumentGuards`)

Appliqués **après** Claude, sans IA :

- `document_type === "QUOTE"` sinon aucun workflow de signature ; `CONTRACT` → revue humaine + message dédié.
- Montants négatifs ignorés ; HT + TVA ≠ TTC (tolérance 0,05) → avertissement + revue humaine.
- Montant TTC absent → avertissement « montant non détecté » + revue humaine (WhatsApp affiche « Non détecté ⚠️ Vérification recommandée »).
- `valid_until` antérieur à la date du jour (fuseau `settings.company.timezone`) → avertissement `QUOTE_EXPIRED : devis potentiellement expiré depuis le JJ/MM/AAAA` + revue humaine. La signature reste possible après validation explicite, l'avertissement est visible sur WhatsApp et dans l'interface.
- `company_id` inconnu de `config/companies.json` → `null` + revue humaine ; plusieurs sociétés candidates (alias ambigu) → `company_id = null` + avertissement « Plusieurs sociétés possibles ». Sans société : **aucune signature**.
- `bank_details_change_suspected` (nouveau RIB dans un devis) → avertissement + revue humaine ; l'action reste proposable mais l'avertissement est affiché.
- `injection_suspected` (Claude ou heuristique `looksLikeInjection`) → revue humaine, aucune action automatique.

## 4. Association à une société et assets

`config/companies.json` (schéma `companySchema`, `src/lib/config.ts`) :

```json
{
  "id": "entreprise-x",
  "name": "Entreprise X",
  "legalName": "Entreprise X SAS",
  "email": "contact@entreprise-x.fr",
  "signatory": { "name": "Prénom Nom", "title": "Président" },
  "signaturePath": "signatures/entreprise-x.png",
  "stampPath": "stamps/entreprise-x.png",
  "quoteApprovalText": "Bon pour accord",
  "stampRequired": true,
  "signaturePlacement": { "mode": "APPEND_APPROVAL_PAGE" },
  "aliases": ["Entreprise X", "ENTREPRISE X SAS"]
}
```

- `signaturePath` / `stampPath` sont **relatifs à `private/`** et doivent respecter `^(signatures|stamps)/[\w.-]+\.png$`. Aucun autre dossier, aucun `..`.
- Dépôt des fichiers : copier les PNG sur le VPS dans `private/signatures/` et `private/stamps/` (SCP/SFTP), propriétaire = utilisateur PM2, droits `600`. Aucun upload via l'interface dans cette phase.
- Vérifications à la lecture (`src/documents/assets.ts`, `loadAsset`) : existence, taille 1 octet – 2 Mo, signature PNG (magic bytes), en-tête IHDR lisible, dimensions entre 20 et 4000 px. SVG, HTML, scripts, fichiers renommés ou corrompus sont refusés avec une erreur `VALIDATION`.
- Avant de proposer une action, `checkSignatureReadiness()` vérifie que la signature est configurée **et** disponible ; sinon « Signature non configurée pour cette société. » (ou « Tampon obligatoire non configuré… » si `stampRequired`). Aucun avertissement n'est ignoré : pas d'asset → pas d'action.
- Libellés logiques exposés à Claude, WhatsApp et l'UI : « Signature Prénom Nom » / « Tampon Entreprise X ». Jamais le chemin.

## 5. Ce que Claude voit et ne voit pas

| Claude reçoit | Claude ne reçoit jamais |
|---|---|
| `document_id`, `email_id`, `company_id` | chemins réels (`private/...`) |
| texte extrait du PDF (encapsulé) | octets du PDF, base64 |
| libellés « Signature X » / « Tampon Y » | images PNG de signature/tampon |
| liste des sociétés (id, nom, alias) | coordonnées de placement |

Un seul tool de signature existe : `prepare_signed_document({ document_id, company_id })` (modes `analyze` et `chat`). Il ne fait que créer l'action `sign_document` en `WAITING_APPROVAL`. Les fonctions `createSignedCopy` / `buildSignedPdf` (`src/documents/sign.ts`, `sign-pdf.ts`) sont **internes**, appelées uniquement par l'exécuteur `sign_document` après validation. Aucun tool `apply_signature` / `apply_stamp` n'est enregistré : Claude ne peut ni les découvrir ni les appeler.

La résolution `company_id → signaturePath / stampPath` n'a lieu que dans `createSignedCopy`, c'est-à-dire **après** la transition atomique `APPROVED → EXECUTING`.

## 6. Action `sign_document` (CRITICAL)

Créée par `prepareQuoteSignature()` (`src/documents/sign.ts`) depuis l'orchestrateur (email `DOCUMENT_TO_SIGN`, `recommended_action = sign_document` ou `signature_requested`), le tool `prepare_signed_document` ou le chat.

- Risque `CRITICAL`, `requires_approval = true` : jamais abaissable, même par une règle ou par une instruction utilisateur (« signe automatiquement tous les devis » est refusé dans le chat).
- Une seule action de signature active par document : un second appel réutilise l'action en attente. Un document déjà signé (`signed_document_id`) n'est jamais re-proposé.
- Payload déterministe (`signDocumentPayload`, `src/actions/types.ts`) : `document_id`, `email_id`, `company_id`, `supplier_name`, `quote_number`, `subject`, montants, `currency`, `valid_until`, `approval_text`, `signature_required`, `stamp_required`, `signature_label`, `stamp_label`, `signer_name`, `signer_title`, `placement_strategy`, `return_to_original_sender`, `reply_to`, `reply_subject`, `reply_body`, `quote_expired`, `warnings`. **Jamais** de base64, de token ni de chemin.
- Le statut du document passe à `sign_proposed` ; entrée `history` `signature.proposed`. Un blocage (pas de société, pas de signature, contrat…) est journalisé `signature.blocked` sans créer d'action.

## 7. Validation : une seule décision

Le message WhatsApp (`src/integrations/whatsapp/approvals.ts`, titre « 📄 EMA — Devis à signer ») résume fournisseur, référence, objet, montant (ou « Non détecté ⚠️ Vérification recommandée »), société, les étapes « ✓ Bon pour accord ✓ Date du jour ✓ Signature … ✓ Tampon … ✓ Copie signée ✓ Retour au fournisseur », les avertissements (expiration, RIB, montant élevé ≥ `settings.signature.warningAmount`) et la note « ⚠️ Cette action appliquera réellement votre signature enregistrée sur une copie du devis (l'original reste inchangé). ».

Une seule validation (bouton VALIDER ou bouton « Valider et signer » de la page À valider) couvre toutes les étapes. REFUSER → action `REJECTED`, aucun PDF signé, aucun email. Les protections de la phase 3 restent en vigueur : numéro autorisé unique, signature HMAC du webhook, dédoublonnage `webhook_events`, transition atomique — une double validation (WhatsApp + UI simultanés, rejeu de webhook) ne produit qu'une copie et qu'un envoi.

## 8. Génération de la copie signée (`createSignedCopy` + `buildSignedPdf`)

1. Idempotence : si `original.signed_document_id` existe déjà, la copie est **réutilisée** (`document.signed_reused`) — jamais de second PDF.
2. Contrôles : société connue, signature (et tampon si requis) chargés depuis `private/`, PDF original présent et **empreinte SHA-256 identique** à celle enregistrée (sinon `CONFLICT`).
3. `pdf-lib` charge l'original avec `ignoreEncryption: false`. PDF chiffré, corrompu ou sans page → erreur `VALIDATION` (« Le PDF est protégé : il ne peut pas être signé automatiquement »), action `FAILED`, aucun envoi, jamais de contournement.
4. Date générée par le serveur dans `settings.company.timezone` (`JJ/MM/AAAA` sur le document, ISO en base).
5. Placement déterministe :
   - `APPEND_APPROVAL_PAGE` (défaut) : une page A4 ajoutée en fin de document : titre = `quoteApprovalText` en capitales, société, date, signataire + fonction, image de signature (ajustée dans 220×80 pt), image de tampon (160×120 pt), note « Signature enregistrée et tampon apposés électroniquement par EMA après validation humaine ».
   - `OVERLAY_LAST_PAGE` : uniquement si configuré explicitement (`page: "last"`, `approvalText {x,y}`, `date {x,y}`, `signature {x,y,width,height}`, `stamp {x,y,width,height}` optionnel). Les coordonnées viennent de `config/companies.json`, jamais de Claude.
6. Écriture dans `private/signed-documents/<yyyy>/<mm>/<document_id>-<nom>-signed-<YYYYMMDD>.pdf`, puis nouvelle ligne `documents` (catégorie `signed`, `parent_document_id`, `sha256`, `company_id`, `signed_at`) et mise à jour de l'original (`signed_path`, `signed_document_id`, `signed_action_id`, `signed_approval_id`, `status = signed`). Entrées `history` : `signature.assets_selected`, `document.signed` (empreintes des deux fichiers).

L'original n'est **jamais** modifié ni écrasé (sa taille, son chemin et son empreinte restent ceux de l'import).

## 9. Retour Outlook et statuts

L'exécuteur (`src/actions/executors/signing.ts`) répond **dans le thread d'origine** (`/messages/{id}/reply`, jamais `replyAll`) avec `reply_body` (issu de `settings.signature.replyTemplate` + signature de l'utilisateur) et **une seule pièce jointe : le PDF signé**. Les PNG, l'original et tout autre fichier privé ne sont jamais joints.

| Étape | Original | Copie signée | Action |
|---|---|---|---|
| préparation | `sign_proposed` | — | `WAITING_APPROVAL` |
| refus | `analyzed` (inchangé) | — | `REJECTED` |
| signature OK, envoi KO | `signed` | `signed` | `FAILED` (retry possible) |
| envoi OK | `signed_and_sent` (`sent_at`) | `sent` | `COMPLETED` |

Nouvel essai (`POST /api/actions/{id}/retry`) après un échec Graph : la copie existante est réutilisée, l'email est envoyé une seule fois. Libellés UI (page Documents) : À analyser, Analysé, À valider, Refusé, Signé, Envoyé, Échec ; onglet « Devis signés » ; le détail d'un document affiche la chaîne original → copie signée, l'expiration et les liens `/api/documents/{id}/file` (original) et `?version=signed`.

## 10. Paramètres

`config/settings.json` :

```json
"signature": {
  "warningAmount": 10000,
  "replySubjectPrefix": "Devis signé —",
  "replyTemplate": "Bonjour,\n\nVeuillez trouver en pièce jointe le devis signé avec notre bon pour accord.\n\nBien cordialement,"
}
```

`warningAmount` ajoute un avertissement « Montant élevé » ; il ne change pas le niveau de risque (toujours CRITICAL).

## 11. Tests (`tests/signing.test.ts`)

19 tests, sans WhatsApp, Outlook ni signature réelle : PNG générés en mémoire, PDF générés par pdf-lib, Anthropic/WhatsApp/Graph mockés. Couverture : APPEND / OVERLAY, PDF corrompu / chiffré / image illisible, assets (absent, SVG renommé, dimensions, chemin invalide), garde-fous (expiré, montants incohérents, société inconnue/ambiguë, sans montant), préparation (payload sans chemin ni base64, idempotence, message WhatsApp), refus (signature absente, tampon obligatoire, société manquante, contrat, injection, déjà signé), validation WhatsApp de bout en bout (copie, chaînage, original intact, pièce jointe unique, statuts, historique sans base64), refus, échec Graph puis retry sans second PDF, double validation / rejeu de webhook, PDF protégé → FAILED, mauvais `company_id` / empreinte modifiée, flux `analyzeEmail` (Claude ne reçoit aucune image), contrat refusé, tools (`apply_signature` / `apply_stamp` inexistants) et chat.

## 12. Limites connues

- Pas d'OCR : un devis scanné (sans texte) n'est jamais signé automatiquement.
- Pas d'upload de signature/tampon dans l'interface : dépôt manuel dans `private/`.
- `OVERLAY_LAST_PAGE` nécessite des coordonnées mesurées par le client ; aucune détection automatique de zone de signature.
- Signature graphique uniquement ; aucune valeur probante de signature électronique qualifiée.
