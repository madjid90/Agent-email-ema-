# Mise en service d'un nouveau client EMA

Depuis le 18/09/2026, **un client = un compte EMA** sur une instance qui peut en héberger plusieurs : chaque dirigeant crée son compte, connecte SA boîte Outlook et active SON numéro WhatsApp vers le numéro EMA central. Aucun code n'est à modifier, aucune variable spécifique au client. (Une instance dédiée par client reste possible : même procédure, un seul compte.)

### Nouveau dirigeant en 5 minutes (instance déjà déployée)

1. `ALLOW_SIGNUP=true` dans `.env` (ou premier compte de l'instance) → `https://ema.client.fr/login` → **Créer un compte** (nom, email, mot de passe ≥ 12 caractères).
2. **Paramètres → Connexions → Connecter Outlook** → consentement Microsoft → « Connecté ✅ ».
3. **Paramètres → Connexions → WhatsApp** → numéro → **Continuer** → **Ouvrir WhatsApp** → envoyer « Bonjour EMA » → réponse de bienvenue.
4. Sur WhatsApp : « Quels sont mes emails importants ? » → réponse fondée sur SA boîte uniquement.
5. « Réponds à Julien que je valide son devis » → brouillon → « Oui » → envoi via Mail.Send → confirmation.

Durée indicative : 2 h à 3 h, hors délais de validation Microsoft et Meta.

## Checklist

| # | Étape | Fait quand |
|---|---|---|
| 1 | **VPS** Ubuntu 22.04/24.04, 1 vCPU / 2 Go / 40 Go, utilisateur `ema` dédié, `ufw` actif (OpenSSH + Nginx Full) | `ssh ema@vps` fonctionne |
| 2 | **Domaine** `ema.client.fr` pointant sur le VPS (A/AAAA) | `dig +short ema.client.fr` renvoie l'IP |
| 3 | **HTTPS** Nginx + Certbot, port 3000 fermé au public | `curl -I https://ema.client.fr/login` en 200 |
| 4 | **Installation** `git clone`, `npm ci`, `.env`, `npm run db:migrate`, `npm run doctor`, `npm run build`, `pm2 start ecosystem.config.cjs` (voir `docs/deployment.md`) | `npm run doctor` sans FAIL |
| 5 | `APP_SECRET` généré (`openssl rand -hex 32`) ; premier compte créé depuis `/login` ; `ALLOW_SIGNUP` selon le nombre de dirigeants | connexion à `/login` réussie |
| 6 | **Anthropic** clé API du client (ou de l'agence pour un pilote), `ANTHROPIC_MODEL` inchangé | Paramètres → Claude « Configuré » |
| 7 | **Microsoft OAuth** App Registration (multi-tenant `common` si plusieurs clients), `MICROSOFT_REDIRECT_URI=https://ema.client.fr/api/integrations/microsoft/callback`, permissions déléguées `openid profile offline_access User.Read Mail.Read Mail.Send`, connexion depuis Paramètres → Connexions | Connexions → Outlook « Connecté ✅ boite@client.fr » |
| 8 | **WhatsApp EMA** numéro Business central, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_BUSINESS_NUMBER`, webhook `https://ema.client.fr/api/integrations/whatsapp/webhook` abonné (champ `messages`) ; le dirigeant active son numéro depuis Connexions | message de bienvenue reçu après « Bonjour EMA » |
| 9 | **Société(s)** dans Sociétés : nom, forme, signataire, texte d'accord, tampon obligatoire ou non | au moins une société enregistrée |
| 10 | **Contacts** internes (comptabilité, travaux, direction) dans `config/contacts.json` | destinataires de règlement résolus sans ambiguïté |
| 11 | **Règles** de routage (`config/rules.json`) : au minimum « facture → comptabilité » | une facture de test est routée |
| 12 | **Signature et tampon** importés depuis Sociétés (PNG, fond transparent, 300×100 px environ pour la signature) | badges « OK » dans Sociétés |
| 13 | **Tests** parcours complets : email → réponse validée, facture → transfert, devis → signature, relance → validation (voir `docs/pilot-checklist.md`) | matrice E2E remplie |
| 14 | **Sauvegarde** cron quotidien + copie chiffrée hors VPS + un `restore` testé sur une instance jetable | `backups/` contient une archive du jour |
| 15 | **Formation** 45 min : Aujourd'hui, À valider, WhatsApp (questions, brouillons, validation), Relances, limites (aucun paiement, aucune signature sans validation) | le client valide seul une action réelle |

## Points de vigilance

- **Ne jamais réutiliser** le même `APP_SECRET`, la même App Registration ou le même numéro WhatsApp entre deux clients.
- **Ne jamais copier** une base ou un dossier `private/` d'un client vers un autre.
- La signature importée doit être une **signature de test** tant que le client n'a pas validé le rendu du PDF signé.
- Le mot de passe de l'interface et les secrets vivent dans le gestionnaire de mots de passe de l'agence, jamais dans un email.
- Après chaque mise à jour : `./scripts/backup.sh` avant `git pull`, puis `npm run doctor`.

## Suppression d'une instance

Voir `docs/privacy.md` (export des données, révocation Microsoft et Meta, destruction du VPS).
