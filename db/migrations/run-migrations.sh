#!/usr/bin/env bash
#
# Run a curated list of SQL scripts against the configured Postgres database.
#
# Usage:
#   db/migrations/run-migrations.sh                 # runs SCRIPTS list below
#   db/migrations/run-migrations.sh file1.sql file2.sql   # runs only the args (paths relative to this folder)
#
# Reads SQL_HOST, SQL_PORT, SQL_USER, SQL_PASSWORD, SQL_DATABASE from .env in the project root.
# The bootstrap script (0000_create_database.sql) instead connects to
# SQL_ADMIN_DATABASE (default: postgres) as SQL_ADMIN_USER / SQL_ADMIN_PASSWORD
# (default: SQL_USER / SQL_PASSWORD), since the target database may not exist yet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

# Edit this list to control what gets applied when called with no arguments.
SCRIPTS=(
  '0001_init.sql'
  0002_platform_settings.sql
  0003_superadmin_user_management.sql
  0004_owner_can_set_app_role.sql
  0005_log_source_scan_counts.sql
  0006_update_log_source.sql


)

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

# Load DB env vars without leaking the rest of .env into the shell.
while IFS='=' read -r key value; do
  case "$key" in
    SQL_HOST|SQL_PORT|SQL_USER|SQL_PASSWORD|SQL_DATABASE|SQL_ADMIN_USER|SQL_ADMIN_PASSWORD|SQL_ADMIN_DATABASE)
      # Strip trailing CR (CRLF line endings) and surrounding whitespace
      value="${value%$'\r'}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      # Strip surrounding quotes
      value="${value%\"}"; value="${value#\"}"
      value="${value%\'}"; value="${value#\'}"
      export "$key=$value"
      ;;
  esac
done < <(grep -E '^(SQL_HOST|SQL_PORT|SQL_USER|SQL_PASSWORD|SQL_DATABASE|SQL_ADMIN_USER|SQL_ADMIN_PASSWORD|SQL_ADMIN_DATABASE)=' "$ENV_FILE")

: "${SQL_HOST:?SQL_HOST missing in .env}"
: "${SQL_PORT:?SQL_PORT missing in .env}"
: "${SQL_USER:?SQL_USER missing in .env}"
: "${SQL_PASSWORD:?SQL_PASSWORD missing in .env}"
: "${SQL_DATABASE:?SQL_DATABASE missing in .env}"
SQL_ADMIN_USER="${SQL_ADMIN_USER:-$SQL_USER}"
SQL_ADMIN_PASSWORD="${SQL_ADMIN_PASSWORD:-$SQL_PASSWORD}"
SQL_ADMIN_DATABASE="${SQL_ADMIN_DATABASE:-postgres}"

if [[ $# -gt 0 ]]; then
  TO_RUN=("$@")
else
  TO_RUN=("${SCRIPTS[@]}")
fi

echo "Applying ${#TO_RUN[@]} script(s) to $SQL_DATABASE@$SQL_HOST:$SQL_PORT"

# Postgres image used when no host `psql` is available (e.g. on a deploy host
# that only has Docker installed).
PG_IMAGE="${PG_IMAGE:-postgres:15}"

# Resolve how we invoke psql: prefer a host binary, otherwise run it inside a
# throwaway Postgres container. The container mounts the scripts dir read-only
# so each .sql file is reachable at the same path inside the container.
if command -v psql >/dev/null 2>&1; then
  # run_psql <file> <user> <password> <database> [extra psql args...]
  run_psql() {
    local file="$1" user="$2" pass="$3" db="$4"; shift 4
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 \
         -h "$SQL_HOST" -p "$SQL_PORT" -U "$user" -d "$db" \
         "$@" -f "$file"
  }
elif command -v docker >/dev/null 2>&1; then
  echo "psql not found on host; using Docker image $PG_IMAGE"
  run_psql() {
    local file="$1" user="$2" pass="$3" db="$4"; shift 4
    docker run --rm \
      -e PGPASSWORD="$pass" \
      -v "$SCRIPT_DIR:/scripts:ro" \
      "$PG_IMAGE" \
      psql -v ON_ERROR_STOP=1 \
           -h "$SQL_HOST" -p "$SQL_PORT" -U "$user" -d "$db" \
           "$@" -f "/scripts/$(basename "$file")"
  }
else
  echo "error: neither psql nor docker is available to run migrations" >&2
  exit 1
fi

for file in "${TO_RUN[@]}"; do
  path="$SCRIPT_DIR/$file"
  if [[ ! -f "$path" ]]; then
    echo "  skip (not found): $file" >&2
    exit 1
  fi
  if [[ "$(basename "$file")" == 0000_create_database.sql ]]; then
    echo "  → $file (as $SQL_ADMIN_USER on $SQL_ADMIN_DATABASE)"
    run_psql "$path" "$SQL_ADMIN_USER" "$SQL_ADMIN_PASSWORD" "$SQL_ADMIN_DATABASE" \
      -v owner="$SQL_USER" -v owner_password="$SQL_PASSWORD" -v db="$SQL_DATABASE"
  else
    echo "  → $file"
    run_psql "$path" "$SQL_USER" "$SQL_PASSWORD" "$SQL_DATABASE"
  fi
done

echo "Done."
