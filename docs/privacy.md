# Confidentialité, données et réversibilité

## 1. Une instance par client

```
CLIENT A → VPS A → data/ema.db A → private/ A → config/ A → .env A
CLIENT B → VPS B → data/ema.db B → private/ B → config/ B → .env B
```

EMA n'est pas multi-tenant. Il n'existe **aucune base centrale**, aucun service partagé, aucune télémétrie vers l'agence. Deux clients ne partagent ni base, ni documents, ni secrets, ni numéro WhatsApp, ni App Registration Microsoft.

Toutes les données vivent sur le VPS du client :

| Donnée | Emplacement |
|---|---|
| Emails synchronisés, analyses, actions, historique, relances, conversation WhatsApp | `data/ema.db` (SQLite) |
| Pièces jointes, documents signés, signatures, tampons | `private/` (droits `700`, jamais servi par Nginx) |
| Sociétés, contacts, règles, paramètres | `config/*.json` |
| Secrets (clés API, mot de passe, tokens chiffrés) | `.env` (droits `600`) et table `oauth_tokens` chiffrée AES-256-GCM |

## 2. Données transmises à des tiers

| Destinataire | Ce qui est transmis | Pourquoi | Ce qui n'est jamais transmis |
|---|---|---|---|
| **Microsoft Graph** | lecture des emails de la boîte connectée, envoi des réponses, transferts et pièces jointes validés | c'est la boîte email du client | rien d'autre : EMA n'utilise pas `Mail.ReadWrite` et ne modifie aucun email |
| **Anthropic (Claude)** | l'email courant, son thread borné, le texte extrait des PDF, les règles, sociétés et contacts utiles à la décision | comprendre la demande et proposer une action | clés, tokens, mots de passe, images de signature ou de tampon, chemins de fichiers, boîte entière |
| **Meta (WhatsApp Business)** | résumé de l'action à valider (expéditeur, objet, montant, société, texte proposé), messages de la conversation avec l'utilisateur | validation et pilotage | pièces jointes brutes, secrets, signature, tampon |

Aucun autre tiers n'est appelé. Aucune analyse n'est envoyée à l'agence.

## 3. Journalisation

Les journaux contiennent des identifiants techniques, des compteurs et des messages d'erreur. Ils ne contiennent ni token, ni mot de passe, ni signature, ni contenu de document ; les adresses email et numéros de téléphone y sont masqués (`k***@client.fr`, `33…78`).

## 4. Export des données du client

```bash
cd ~/ema
./scripts/backup.sh /home/ema/export        # base + documents + config (sans secrets)
sqlite3 data/ema.db .dump > /home/ema/export/ema-dump.sql   # optionnel : SQL lisible
```

L'archive `ema-backup-*.tar.gz` contient l'intégralité des données exploitables : base SQLite, documents originaux et signés, signatures, tampons, configuration. La remettre au client par un canal chiffré. `.env` n'est pas inclus : les secrets sont remis séparément ou révoqués.

## 5. Suppression d'une instance

1. **Arrêter EMA** : `pm2 delete all && pm2 save`.
2. **Exporter** si le client le demande (section 4), puis lui remettre l'archive.
3. **Révoquer Microsoft** : dans Azure AD, supprimer l'App Registration dédiée ou retirer le consentement ; côté utilisateur, `https://myaccount.microsoft.com/` → Applications → retirer EMA. Le refresh token stocké devient inutilisable.
4. **Révoquer Meta** : supprimer le webhook et le token d'accès de l'application WhatsApp Business, retirer le numéro autorisé.
5. **Révoquer Anthropic** : supprimer la clé API de l'organisation.
6. **Effacer les données** :
   ```bash
   shred -u ~/ema/.env
   rm -rf ~/ema/data ~/ema/private ~/ema/config/*.json ~/ema/backups
   ```
7. **Détruire le VPS** (suppression de l'instance chez l'hébergeur) : c'est la garantie la plus simple qu'il ne reste rien.
8. Supprimer les secrets du gestionnaire de mots de passe de l'agence et l'entrée DNS.

## 6. Suppression partielle

- Un document : le supprimer dans `private/documents/...` et retirer sa ligne dans `documents` (SQL), ou restaurer une sauvegarde antérieure.
- La conversation WhatsApp : `DELETE FROM chat_messages WHERE channel = 'WHATSAPP';`.
- Les emails synchronisés : `DELETE FROM emails;` puis relancer une synchronisation depuis `/setup` (les analyses et actions liées sont détachées, pas les documents déjà archivés).

Toute suppression manuelle se fait EMA arrêté (`pm2 stop all`), après sauvegarde.
