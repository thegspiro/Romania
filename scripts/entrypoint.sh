#!/bin/sh
#
# Container entrypoint. Selects the role from the first argument.
#
# POSIX sh, not bash: the runtime image has dash as /bin/sh and there is no
# reason for the deployment scripts to depend on a larger shell.
set -eu

ROLE="${1:-web}"

log() {
  # Timestamped so container logs interleave readably with the app's own.
  printf '%s entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# Wait for the database before doing anything that needs it. Compose's
# depends_on only waits for the container to start, not for MySQL to finish
# its own initialisation, which on a first run takes tens of seconds.
"$(dirname "$0")/wait-for-db.sh"

case "$ROLE" in
  web)
    # Migrations run from the web role only. Running them from every role
    # would have several containers racing; the advisory lock in the runner
    # makes that safe, but there is no reason to rely on it.
    if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
      log "applying database migrations"
      node dist/db/migrate.js up
    fi
    log "starting web service"
    exec node dist/index.js
    ;;

  worker)
    log "starting background worker"
    exec python3 -m worker.runner
    ;;

  migrate)
    shift || true
    exec node dist/db/migrate.js "$@"
    ;;

  admin)
    shift || true
    exec node dist/cli/admin.js "$@"
    ;;

  shell)
    exec /bin/sh
    ;;

  *)
    # Anything else is run verbatim, so `docker compose run app <command>`
    # still works for one-off tasks.
    exec "$@"
    ;;
esac
