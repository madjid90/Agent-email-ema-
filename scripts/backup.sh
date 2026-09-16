#!/usr/bin/env bash
# Sauvegarde d'EMA : base SQLite, config, documents, documents signés, signatures, tampons.
# Usage : ./scripts/backup.sh [dossier_destination] [--keep N]
# Aucun secret n'est inclus (.env n'est PAS sauvegardé : il est recréé à l'installation).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/backups}"
KEEP=7
if [ "${2:-}" = "--keep" ] && [ -n "${3:-}" ]; then KEEP="$3"; fi
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
ARCHIVE="$DEST/ema-backup-$STAMP.tar.gz"
trap 'rm -rf "$WORK"' EXIT

DB_PATH="./data/ema.db"; PRIV="./private"; CFG="./config"
if [ -f "$ROOT/.env" ]; then
  DB_PATH="$(grep -E '^DATABASE_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; DB_PATH="${DB_PATH:-./data/ema.db}"
  PRIV="$(grep -E '^PRIVATE_STORAGE_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; PRIV="${PRIV:-./private}"
  CFG="$(grep -E '^CONFIG_PATH=' "$ROOT/.env" | cut -d= -f2- || true)"; CFG="${CFG:-./config}"
fi
cd "$ROOT"
mkdir -p "$DEST" "$WORK/data" "$WORK/private" "$WORK/config"

# Base SQLite : copie cohérente via better-sqlite3 (WAL inclus), vérifiée.
DB_OK="absent"
SNAPSHOT="{}"
if [ -f "$DB_PATH" ]; then
  if SNAPSHOT="$(node "$ROOT/scripts/db-snapshot.cjs" "$DB_PATH" "$WORK/data/ema.db" 2>&1)"; then
    DB_OK="ok"
  elif command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$WORK/data/ema.db'"
    DB_OK="sqlite3"
    SNAPSHOT="{}"
  else
    echo "Sauvegarde interrompue : copie de la base impossible ($SNAPSHOT)"
    exit 1
  fi
fi

for d in documents signed-documents signatures stamps; do
  [ -d "$PRIV/$d" ] && cp -R "$PRIV/$d" "$WORK/private/" || true
done
# Config réelle uniquement (les *.example.json sont dans git, .env n'est jamais inclus)
for f in settings rules contacts companies; do
  [ -f "$CFG/$f.json" ] && cp "$CFG/$f.json" "$WORK/config/" || true
done

# Métadonnées de la sauvegarde (vérifiées à la restauration)
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "inconnue")"
COUNTS="$(node -p "try{JSON.stringify((JSON.parse(process.argv[1]).counts)||{})}catch(e){'{}'}" "$SNAPSHOT" 2>/dev/null || echo "{}")"
cat > "$WORK/backup.json" <<META
{
  "tool": "ema-backup",
  "version": "$VERSION",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(hostname)",
  "database": "$DB_OK",
  "counts": $COUNTS,
  "contents": ["data/ema.db", "config/*.json", "private/documents", "private/signed-documents", "private/signatures", "private/stamps"],
  "excludes": [".env", "node_modules", ".next", "logs", "backups"]
}
META

tar -czf "$ARCHIVE" -C "$WORK" .
chmod 600 "$ARCHIVE"

# Rétention : conserver les N dernières sauvegardes
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$DEST"/ema-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
fi

echo "Sauvegarde créée : $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1)) — base : $DB_OK, rétention : $KEEP"
