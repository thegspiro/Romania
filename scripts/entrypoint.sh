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

HERE="$(dirname "$0")"

# Wait for the database before doing anything that needs it. Compose's
# depends_on only waits for the container to start, not for MySQL to finish
# its own initialisation, which on a first run takes tens of seconds.
#
# preflight is the one role that must not wait. Its job is to say what is
# wrong, so blocking for DB_WAIT_TIMEOUT and then dying would withhold exactly
# the report it exists to produce -- and it checks the database itself, in one
# line, alongside everything else.
if [ "$ROLE" != "preflight" ]; then
  "${HERE}/wait-for-db.sh"
fi

case "$ROLE" in
  web)
    # Before the service accepts a request, not lazily on the first upload.
    # A data directory the container cannot write to is a deployment mistake,
    # and it is far cheaper to read it here than out of a 500 later.
    "${HERE}/check-storage.sh"

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
    # The worker writes derivatives to STORAGE_ROOT and dumps to BACKUP_ROOT,
    # so it needs the same guarantee the web role just checked for itself.
    "${HERE}/check-storage.sh"

    log "starting background worker"
    exec python3 -m worker.runner
    ;;

  preflight)
    # Reports on the whole install and exits non-zero if something is broken.
    # Deliberately does not call check-storage.sh first: that aborts on the
    # first unwritable directory, and a report that stops at its first finding
    # sends the operator round the loop once per problem.
    exec node dist/cli/preflight.js
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
