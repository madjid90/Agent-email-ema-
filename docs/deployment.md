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
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_RECIPIENT_NUMBER`
- `APP_URL=https://ema.client.fr`
- `APP_SECRET` : `openssl rand -hex 32`
- `APP_PASSWORD` : mot de passe d'accès à l'interface

Les fichiers `config/*.json` sont créés au premier lancement à partir des `*.example.json` ; ils se modifient ensuite depuis l'interface (`/setup`, Règles, Sociétés) ou en SSH.

### Azure AD (Outlook)

1. Portail Azure → App registrations → New registration.
2. Redirect URI (Web) : `https://ema.client.fr/api/integrations/microsoft/callback`.
3. Certificates & secrets → New client secret → copier dans `.env`.
4. API permissions (Delegated) : `User.Read`, `Mail.Read`, `Mail.Send`, `offline_access`. Voir `docs/outlook.md`.

### WhatsApp Business Cloud API

1. Meta for Developers → app → WhatsApp → API setup : `Phone number ID`, `Access token` (permanent via System User).
2. Webhook : URL `https://ema.client.fr/api/whatsapp/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`, abonnement au champ `messages`.

## 4. Base de données et build

```bash
npm run db:migrate
npm run build
```

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

## 9. Logs

- Application : `pm2 logs`, fichiers dans `~/.pm2/logs/`.
- Nginx : `/var/log/nginx/access.log`, `/var/log/nginx/error.log`.
- Niveau de log : `LOG_LEVEL` dans `.env`.

Rotation : `pm2 install pm2-logrotate`.

## 10. Sauvegarde

```bash
./scripts/backup.sh                # crée backups/ema-backup-YYYYMMDD-HHMMSS.tar.gz
./scripts/backup.sh /mnt/backups   # destination personnalisée
```

Contenu : `data/ema.db` (copie cohérente via `sqlite3 .backup`), `private/documents`, `private/signed-documents`, `private/signatures`, `private/stamps`, `config/`.

Planifier (cron, tous les jours à 3h) :

```
0 3 * * * cd /home/ema/ema && ./scripts/backup.sh /home/ema/backups >> /home/ema/backup.log 2>&1
```

Les archives contiennent des données sensibles : les copier hors du VPS de façon chiffrée.

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

## 13. Dépannage

| Symptôme | Piste |
|---|---|
| `Outlook non connecté` | Refaire l'étape Outlook du setup ; vérifier `MICROSOFT_REDIRECT_URI` identique côté Azure |
| Pas de message WhatsApp | Vérifier `WHATSAPP_ACCESS_TOKEN` (expiration), le numéro destinataire, `pm2 logs ema-worker` |
| Erreur `SQLITE_BUSY` | Un seul worker doit tourner : `pm2 status` |
| Build échoue | `node --version` ≥ 20.11, `npm ci` propre |
