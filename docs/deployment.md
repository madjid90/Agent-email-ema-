# Déploiement d'EMA sur un VPS Ubuntu

Cible : Ubuntu 22.04 / 24.04, 1 vCPU / 2 Go RAM suffisent. Tout tourne sur le VPS du client.

## 1. Installation des prérequis

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx sqlite3 build-essential python3 certbot python3-certbot-nginx
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Créer un utilisateur dédié :

```bash
sudo adduser --disabled-password --gecos "" ema
sudo su - ema
```

## 2. Récupération du code

```bash
git clone <URL_DU_DEPOT> ~/ema
cd ~/ema
npm ci
```

## 3. Configuration

```bash
cp .env.example .env
nano .env
```

Renseigner :

- `ANTHROPIC_API_KEY`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI=https://ema.client.fr/api/integrations/microsoft/callback`
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_APPROVER_PHONE`
- `APP_URL=https://ema.client.fr` — **HTTPS obligatoire** : en production, EMA refuse de démarrer avec une URL en `http://`
- `APP_SECRET` : `openssl rand -hex 32` (32 caractères minimum)
- `APP_PASSWORD` : mot de passe d'accès à l'interface (12 caractères minimum, généré : `openssl rand -base64 18`)

Variables optionnelles : `WHATSAPP_ASSISTANT_ENABLED` (défaut `true`), `WHATSAPP_FOLLOWUP_TEMPLATE_NAME` / `_LANG` (notifications proactives hors fenêtre de 24 h), `LOG_LEVEL`, `WORKER_POLL_INTERVAL`, `EMAIL_SYNC_LIMIT`, `EMAIL_INITIAL_SYNC_DAYS`, `ATTACHMENT_MAX_MB`, `DATABASE_PATH`, `PRIVATE_STORAGE_PATH`, `CONFIG_PATH`.

Au démarrage, EMA vérifie la configuration : une variable obligatoire manquante (secret, mot de passe, HTTPS, WhatsApp partiellement configuré) empêche le démarrage avec un message nommant la variable. Rien ne tourne dans un état partiellement sécurisé.

### Droits des fichiers

```bash
chmod 600 ~/ema/.env
chmod 700 ~/ema/data ~/ema/private ~/ema/config
find ~/ema/private -type d -exec chmod 700 {} \;
find ~/ema/private -type f -exec chmod 600 {} \;
```

EMA resserre ces droits automatiquement à chaque démarrage (dossiers `700`, `.env` et base `600`). `npm run doctor` signale tout chemin lisible au-delà du propriétaire. **Aucun de ces dossiers n'est servi par Nginx** : les documents transitent uniquement par `/api/documents/[id]/file`, après authentification.

Les fichiers `config/*.json` sont créés au premier lancement à partir des `*.example.json` ; ils se modifient ensuite depuis l'interface (`/setup`, Règles, Sociétés) ou en SSH.

### Azure AD (Outlook)

1. Portail Azure → App registrations → New registration.
2. Redirect URI (Web) : `https://ema.client.fr/api/integrations/microsoft/callback`.
3. Certificates & secrets → New client secret → copier dans `.env`.
4. API permissions (Delegated) : `User.Read`, `Mail.Read`, `Mail.Send`, `offline_access`. Voir `docs/outlook.md`.

### WhatsApp Business Cloud API

1. Meta for Developers → app → WhatsApp → API setup : `Phone number ID`, `Access token` (permanent via System User), `App secret` (Paramètres de base) → `WHATSAPP_APP_SECRET`.
2. Webhook : URL `https://ema.client.fr/api/integrations/whatsapp/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`, abonnement au champ `messages`.
3. `WHATSAPP_APPROVER_PHONE` = numéro de l'utilisateur (chiffres, ex. `33612345678`) : seul numéro autorisé à valider. Vérifier avec « Test notification » dans `/setup`. Détails : `docs/whatsapp.md`.

## 4. Base de données, diagnostic et build

```bash
npm run db:migrate
npm run doctor      # PASS / WARN / FAIL, sans afficher aucun secret
npm run build
```

`npm run doctor` vérifie : Node.js, `.env`, configuration, intégrité SQLite et migrations, battement du worker, espace disque, droits des fichiers, intégrations (Anthropic, Outlook, WhatsApp), sociétés et disponibilité des signatures. Code de sortie 1 si un contrôle est en FAIL.

## 5. Lancement avec PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # exécuter la commande affichée avec sudo
```

Deux process : `ema-web` (Next.js, port 3000) et `ema-worker` (scheduler).

```bash
pm2 status
pm2 logs ema-web
pm2 logs ema-worker
pm2 restart all
```

## 6. Nginx

`/etc/nginx/sites-available/ema` :

```nginx
server {
    server_name ema.client.fr;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ema /etc/nginx/sites-enabled/ema
sudo nginx -t && sudo systemctl reload nginx
```

## 7. HTTPS (Let's Encrypt)

```bash
sudo certbot --nginx -d ema.client.fr
```

Le renouvellement est automatique (`systemctl status certbot.timer`).

Fermer le port 3000 au public :

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 8. Première configuration

Ouvrir `https://ema.client.fr/setup` et suivre les 8 étapes (Entreprise, Outlook, Claude, WhatsApp, Règles, Sociétés, Signatures/tampons, Test).

## 9. Supervision et logs

- Santé : `https://ema.client.fr/api/health` renvoie publiquement `{status, version, time}` ; connecté à l'interface, le même point d'entrée renvoie le diagnostic complet (contrôles, disque, worker, coûts) et le code HTTP 503 si un contrôle est en FAIL. Aucun secret n'est exposé dans les deux cas.
- Interface : Paramètres → Diagnostic (contrôles, stockage, consommation Claude par jour) ; alerte automatique quand l'espace disque libre passe sous 10 %.
- Ligne de commande : `npm run doctor`.
- Application : `pm2 logs`, fichiers dans `~/.pm2/logs/`. Nginx : `/var/log/nginx/`.
- Niveau de log : `LOG_LEVEL` dans `.env` (`info` en production).
- Les journaux ne contiennent ni token, ni mot de passe, ni signature, ni contenu de document ; les adresses email et numéros sont masqués (`k***@client.fr`, `33…78`).

Rotation (obligatoire, sinon les journaux remplissent le disque) :

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## 10. Sauvegarde

```bash
./scripts/backup.sh                # crée backups/ema-backup-YYYYMMDD-HHMMSS.tar.gz
./scripts/backup.sh /mnt/backups   # destination personnalisée
```

Contenu : `data/ema.db` (copie cohérente via l'API `backup` de better-sqlite3, vérifiée par `PRAGMA integrity_check`), `private/documents`, `private/signed-documents`, `private/signatures`, `private/stamps`, `config/*.json`, plus un fichier `backup.json` (version, date, hôte, compteurs de lignes).

**`.env` n'est jamais sauvegardé** : il contient les secrets et se recrée à l'installation. Conserver les secrets dans le gestionnaire de mots de passe de l'agence.

Rétention : les 7 dernières archives sont conservées (`./scripts/backup.sh /home/ema/backups --keep 14` pour changer). Chaque archive est en droits `600`.

Planifier (cron, tous les jours à 3h) :

```
0 3 * * * cd /home/ema/ema && ./scripts/backup.sh /home/ema/backups >> /home/ema/backup.log 2>&1
```

Les archives contiennent des données client : les copier hors du VPS de façon chiffrée (`rsync` vers un stockage chiffré, ou `age`/`gpg` avant transfert). Aucun service cloud n'est requis.

## 11. Restauration

```bash
pm2 stop all
./scripts/restore.sh backups/ema-backup-20260915-030000.tar.gz
pm2 start all
```

Le script sauvegarde l'état courant dans `backups/pre-restore-*.tar.gz` avant d'écraser quoi que ce soit.

## 12. Mise à jour

```bash
cd ~/ema
./scripts/backup.sh
git pull
npm ci
npm run db:migrate
npm run build
pm2 restart all
```

## 13. Installation neuve : vérification finale

À la fin d'une installation, ces huit points doivent être vrais :

1. `npm run doctor` → aucun FAIL.
2. `npm run check` → typecheck, lint, tests et build verts (sur une machine de développement ; sur le VPS, `npm run build` suffit).
3. `pm2 status` → `ema-web` et `ema-worker` en ligne.
4. `curl -s https://ema.client.fr/api/health` → `{"ok":true,...}`.
5. `https://ema.client.fr/login` répond et refuse un mauvais mot de passe (8 tentatives maximum, puis blocage 15 minutes).
6. `https://ema.client.fr/setup` redirige vers `/login` sans session.
7. `curl -I https://ema.client.fr/login` → `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`.
8. `./scripts/backup.sh` puis `./scripts/restore.sh` sur une instance de test → intégrité `ok`.

## 14. Dépannage

| Symptôme | Piste |
|---|---|
| `Outlook non connecté` | Refaire l'étape Outlook du setup ; vérifier `MICROSOFT_REDIRECT_URI` identique côté Azure |
| Pas de message WhatsApp | Vérifier `WHATSAPP_ACCESS_TOKEN` (expiration), le numéro destinataire, `pm2 logs ema-worker` |
| Erreur `SQLITE_BUSY` | Un seul worker doit tourner : `pm2 status` |
| Build échoue | `node --version` ≥ 20.11, `npm ci` propre |
| `Configuration incomplète, EMA ne peut pas démarrer` | La variable nommée dans le message manque dans `.env` (souvent `APP_URL` en `http://`) |
| `/api/health` en 503 | Un contrôle est en FAIL : ouvrir Paramètres → Diagnostic ou lancer `npm run doctor` |
| Worker « aucun battement » | `pm2 restart ema-worker`, puis `pm2 logs ema-worker` |
| Espace disque faible | Purger `backups/`, vérifier la taille de `private/documents` (Paramètres → Diagnostic) |
| Notifications WhatsApp en attente | Fenêtre de 24 h fermée : configurer `WHATSAPP_FOLLOWUP_TEMPLATE_NAME` (voir `docs/followups.md`) |
