#!/bin/sh
# Runs one AutoDev service from the shared image: the first argument, else AUTODEV_SERVICE:
#   api | worker | gateway | migrate (runs database migrations, then exits)
#   docker run autodev migrate   ·   fly release_command "/usr/local/bin/autodev migrate"
# MIGRATE_ON_START=1 runs migrations before the API starts (for hosts without a release step).
set -e
# Some hosts pass the command through the entrypoint too ("autodev /usr/local/bin/autodev migrate").
case "${1:-}" in /usr/local/bin/autodev | autodev) shift ;; esac
SERVICE="${1:-${AUTODEV_SERVICE:-api}}"
case "$SERVICE" in
  api)
    if [ "${MIGRATE_ON_START:-0}" = "1" ]; then (cd /app/packages/db && node_modules/.bin/tsx src/migrate.ts); fi
    exec node /app/apps/api/dist/main.js ;;
  worker) exec node /app/apps/worker/dist/main.js ;;
  gateway) exec node /app/apps/builder-gateway/dist/main.js ;;
  migrate) cd /app/packages/db && exec node_modules/.bin/tsx src/migrate.ts ;;
  *) echo "The service must be api, worker, gateway or migrate (got '$SERVICE')" >&2; exit 64 ;;
esac
