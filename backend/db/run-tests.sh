#!/usr/bin/env bash
# Runs the RLS isolation tests as the owner role (rolls everything back).
# Reads SQL_HOST / SQL_PORT / SQL_USER / SQL_PASSWORD / SQL_DATABASE from <project root>/.env.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//"; }
PGPASSWORD="$(get SQL_PASSWORD)" psql -X -v ON_ERROR_STOP=1 \
  -h "$(get SQL_HOST)" -p "$(get SQL_PORT || echo 5432)" -U "$(get SQL_USER)" -d "$(get SQL_DATABASE)" \
  -f "$SCRIPT_DIR/tests/rls.test.sql"
