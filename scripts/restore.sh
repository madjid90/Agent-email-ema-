#!/usr/bin/env bash
# Restauration d'une sauvegarde EMA. Arrêter EMA avant (pm2 stop all).
# Usage : ./scripts/restore.sh chemin/vers/ema-backup-XXXX.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="${1:-}"
[ -f "$ARCHIVE" ] || { echo "Usage : $0 <archive.tar.gz>"; exit 1; }

DB_PATH="./data/ema.db"; PRIV="./private"; CFG="./config"
if [ -f "$ROOT/.env" ]; then
  DB_PATH="$(grep -E '^DATABASE_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; DB_PATH="${DB_PATH:-./data/ema.db}"
  PRIV="$(grep -E '^PRIVATE_STORAGE_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; PRIV="${PRIV:-./private}"
  CFG="$(grep -E '^CONFIG_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; CFG="${CFG:-./config}"
fi
cd "$ROOT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# L'archive à restaurer est copiée AVANT toute écriture : la sauvegarde de
# sécurité ci-dessous écrit dans backups/ et ne doit jamais pouvoir l'écraser.
cp "$ARCHIVE" "$WORK/source.tar.gz"

# Sauvegarde de sécurité de l'état courant, écrite hors de backups/ puis déposée
# sous un nom distinct (pre-restore-*), sans renommer aucune archive existante.
SAFE="$WORK/safety"
mkdir -p "$SAFE" "$ROOT/backups"
if "$ROOT/scripts/backup.sh" "$SAFE" --keep 0 >/dev/null 2>&1; then
  SAFE_FILE="$(ls -t "$SAFE"/ema-backup-*.tar.gz 2>/dev/null | head -1 || true)"
  if [ -n "$SAFE_FILE" ]; then
    mv "$SAFE_FILE" "$ROOT/backups/pre-restore-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "État courant sauvegardé dans backups/ (pre-restore-*)"
  fi
fi

tar -xzf "$WORK/source.tar.gz" -C "$WORK"

# Métadonnées : contrôle minimal avant d'écraser l'installation
if [ -f "$WORK/backup.json" ]; then
  echo "Sauvegarde : $(node -p "const m=require('$WORK/backup.json'); \`version \${m.version}, créée le \${m.created_at}, base \${m.database}\`" 2>/dev/null || echo 'métadonnées illisibles')"
else
  echo "Attention : archive sans métadonnées (sauvegarde antérieure à la version 0.8.0)."
fi

mkdir -p "$(dirname "$DB_PATH")" "$PRIV" "$CFG"
if [ -f "$WORK/data/ema.db" ]; then
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
  cp "$WORK/data/ema.db" "$DB_PATH"
  [ -f "$WORK/data/ema.db-wal" ] && cp "$WORK/data/ema.db-wal" "$DB_PATH-wal" || true
fi
for d in documents signed-documents signatures stamps; do
  if [ -d "$WORK/private/$d" ]; then
    rm -rf "$PRIV/$d"
    cp -R "$WORK/private/$d" "$PRIV/$d"
  fi
done
for f in settings rules contacts companies; do
  [ -f "$WORK/config/$f.json" ] && cp "$WORK/config/$f.json" "$CFG/$f.json" || true
done
rm -rf "$WORK"
echo "Restauration terminée depuis $ARCHIVE. Relancer EMA (pm2 start all)."

# Intégrité après restauration (better-sqlite3, sans dépendre du binaire sqlite3)
if [ -f "$DB_PATH" ]; then
  INTEGRITY="$(node -e "const D=require('$ROOT/node_modules/better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare('PRAGMA integrity_check').get().integrity_check);db.close()" "$DB_PATH" 2>/dev/null || echo "inconnue")"
  echo "Intégrité SQLite après restauration : $INTEGRITY"
  [ "$INTEGRITY" = "ok" ] || exit 1
fi
npm run db:migrate --silent >/dev/null 2>&1 && echo "Migrations appliquées." || echo "Appliquer les migrations manuellement : npm run db:migrate"
echo "Restauration terminée. Redémarrer EMA : pm2 restart all"
