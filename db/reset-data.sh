#!/usr/bin/env bash
#
# Delete ALL data from the database configured in .env, keeping the schema,
# roles and applied migrations. Afterwards the next sign-up becomes the
# superadmin again.
#
# Usage:
#   npm run db:reset                       # asks you to type the database name to confirm
#   npm run db:reset -- --keep-settings    # keep the Settings page values and secrets (API keys, tokens)
#   npm run db:reset -- --yes              # no confirmation prompt (scripts / CI)
#
# Connects as the owner role (SQL_USER / SQL_PASSWORD) from <project root>/.env.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env}"

KEEP_SETTINGS=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --keep-settings) KEEP_SETTINGS=true ;;
    --yes|-y)        ASSUME_YES=true ;;
    -h|--help)       sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

[[ -f "$ENV_FILE" ]] || { echo "error: $ENV_FILE not found" >&2; exit 1; }

# Read KEY=value from .env, stripping CR, surrounding whitespace and quotes.
get() {
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -1 | cut -d= -f2- |
    sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']$//"
}

SQL_HOST="$(get SQL_HOST)";         : "${SQL_HOST:?SQL_HOST missing in .env}"
SQL_PORT="$(get SQL_PORT)";         SQL_PORT="${SQL_PORT:-5432}"
SQL_USER="$(get SQL_USER)";         : "${SQL_USER:?SQL_USER missing in .env}"
SQL_DATABASE="$(get SQL_DATABASE)"; : "${SQL_DATABASE:?SQL_DATABASE missing in .env}"
export PGPASSWORD="$(get SQL_PASSWORD)"
SSLMODE="$(get SQL_SSLMODE)"
[[ -n "$SSLMODE" ]] && export PGSSLMODE="$SSLMODE"

command -v psql >/dev/null 2>&1 || { echo "error: psql not found (brew install libpq)" >&2; exit 1; }

PSQL=(psql -X -v ON_ERROR_STOP=1 -h "$SQL_HOST" -p "$SQL_PORT" -U "$SQL_USER" -d "$SQL_DATABASE")

# Tables that are never cleared.
EXCLUDE="'public.schema_migrations'"
if $KEEP_SETTINGS; then
  EXCLUDE="$EXCLUDE,'public.platform_settings','private.platform_secrets'"
fi

TABLES_SQL="select string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename)
            from pg_tables
            where schemaname in ('public', 'private')
              and format('%s.%s', schemaname, tablename) not in ($EXCLUDE)"

TABLES="$("${PSQL[@]}" -tAc "$TABLES_SQL")"
[[ -n "$TABLES" ]] || { echo "No tables found. Run npm run db:migrate first."; exit 0; }

echo "Database: $SQL_DATABASE @ $SQL_HOST:$SQL_PORT (as $SQL_USER)"
echo "Rows in these tables will be DELETED:"
echo "$TABLES" | tr ',' '\n' | sed 's/^ */  - /'
$KEEP_SETTINGS && echo "Kept: platform settings and secrets."
echo

if ! $ASSUME_YES; then
  read -r -p "Type the database name ($SQL_DATABASE) to confirm: " answer
  [[ "$answer" == "$SQL_DATABASE" ]] || { echo "Aborted. Nothing was deleted."; exit 1; }
fi

"${PSQL[@]}" -q -c "truncate table $TABLES restart identity cascade;"

echo "Done. All data deleted. Open the app and sign up: the first account becomes superadmin."
echo "Restart the app (npm run dev) so old sessions and cached settings are dropped."
