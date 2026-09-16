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

# Chiffrement (phase 8A) : l'archive contient des données client.
# En production, une sauvegarde en clair exige --allow-plaintext.
ALLOW_PLAINTEXT="no"
for arg in "$@"; do if [ "$arg" = "--allow-plaintext" ]; then ALLOW_PLAINTEXT="yes"; fi; done
if [ -f "$ROOT/.env" ] && [ -z "${BACKUP_ENCRYPTION_PASSWORD:-}" ]; then
  BACKUP_ENCRYPTION_PASSWORD="$(grep -E '^BACKUP_ENCRYPTION_PASSWORD=' "$ROOT/.env" | cut -d= -f2- || true)"
  export BACKUP_ENCRYPTION_PASSWORD
fi
NODE_ENV_VALUE="$(grep -E '^NODE_ENV=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
if [ -n "${BACKUP_ENCRYPTION_PASSWORD:-}" ]; then
  if node "$ROOT/scripts/backup-crypto.cjs" encrypt "$ARCHIVE" "$ARCHIVE.enc"; then
    # Effacement de l'archive en clair (écrasement si shred est disponible)
    if command -v shred >/dev/null 2>&1; then shred -u "$ARCHIVE"; else rm -f "$ARCHIVE"; fi
    ARCHIVE="$ARCHIVE.enc"
    chmod 600 "$ARCHIVE"
  else
    rm -f "$ARCHIVE.enc"
    echo "Chiffrement impossible : sauvegarde interrompue (l'archive en clair a été supprimée)."
    rm -f "$ARCHIVE"
    exit 1
  fi
elif [ "$NODE_ENV_VALUE" = "production" ] && [ "$ALLOW_PLAINTEXT" != "yes" ]; then
  rm -f "$ARCHIVE"
  echo "Sauvegarde refusée : BACKUP_ENCRYPTION_PASSWORD absent en production." >&2
  echo "Renseignez-le dans .env (recommandé) ou relancez avec --allow-plaintext en connaissance de cause." >&2
  exit 1
else
  echo "Attention : sauvegarde NON CHIFFRÉE (BACKUP_ENCRYPTION_PASSWORD absent). Elle contient des données client."
fi

# Rétention : conserver les N dernières sauvegardes (chiffrées ou non)
if [ "$KEEP" -gt 0 ]; then
  { ls -1t "$DEST"/ema-backup-*.tar.gz "$DEST"/ema-backup-*.tar.gz.enc 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
fi

echo "Sauvegarde créée : $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1)) — base : $DB_OK, rétention : $KEEP"
