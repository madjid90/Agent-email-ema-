#!/usr/bin/env bash
# Sauvegarde d'EMA : base SQLite, documents, documents signés, signatures, tampons, config.
# Usage : ./scripts/backup.sh [dossier_destination]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
ARCHIVE="$DEST/ema-backup-$STAMP.tar.gz"

# Charger DATABASE_PATH / PRIVATE_STORAGE_PATH / CONFIG_PATH depuis .env si présent (sans exporter les secrets)
DB_PATH="./data/ema.db"; PRIV="./private"; CFG="./config"
if [ -f "$ROOT/.env" ]; then
  DB_PATH="$(grep -E '^DATABASE_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; DB_PATH="${DB_PATH:-./data/ema.db}"
  PRIV="$(grep -E '^PRIVATE_STORAGE_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; PRIV="${PRIV:-./private}"
  CFG="$(grep -E '^CONFIG_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; CFG="${CFG:-./config}"
fi
cd "$ROOT"
mkdir -p "$DEST" "$WORK/data" "$WORK/private" "$WORK/config"

# Base SQLite : copie cohérente via sqlite3 .backup si disponible, sinon copie simple (WAL inclus)
if [ -f "$DB_PATH" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$WORK/data/ema.db'"
  else
    cp "$DB_PATH" "$WORK/data/ema.db"
    [ -f "$DB_PATH-wal" ] && cp "$DB_PATH-wal" "$WORK/data/ema.db-wal" || true
  fi
fi

for d in documents signed-documents signatures stamps; do
  [ -d "$PRIV/$d" ] && cp -R "$PRIV/$d" "$WORK/private/" || true
done
# Config réelle uniquement (les *.example.json sont dans git)
for f in settings rules contacts companies; do
  [ -f "$CFG/$f.json" ] && cp "$CFG/$f.json" "$WORK/config/" || true
done

tar -czf "$ARCHIVE" -C "$WORK" .
rm -rf "$WORK"
echo "Sauvegarde créée : $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
