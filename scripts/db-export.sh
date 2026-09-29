#!/usr/bin/env bash
# Dump the local database (DATABASE_URL in .env) to backup/, for restoring
# into the server's Postgres. docs/deployment.md has the restore command.
#
#   ./scripts/db-export.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DATABASE_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)}"
[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL is not set (.env)." >&2; exit 1; }

mkdir -p backup
OUT="backup/spark-$(date +%F).dump"
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" --file="$OUT"
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
