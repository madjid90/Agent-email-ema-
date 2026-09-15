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

# Sauvegarde de sécurité de l'état courant
"$ROOT/scripts/backup.sh" "$ROOT/backups" >/dev/null 2>&1 && echo "État courant sauvegardé dans backups/ (pre-restore)"
LAST="$(ls -t "$ROOT/backups"/ema-backup-*.tar.gz 2>/dev/null | head -1 || true)"
[ -n "$LAST" ] && mv "$LAST" "${LAST/ema-backup/pre-restore}" || true

WORK="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$WORK"

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
