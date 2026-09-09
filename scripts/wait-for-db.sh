#!/bin/sh
#
# Blocks until MySQL accepts connections, or gives up.
#
# Uses mysqladmin rather than a TCP port check: the port opens well before the
# server finishes initialising on a first run, and connecting too early gives
# a confusing "unknown database" failure instead of a clear wait.
set -eu

HOST="${DB_HOST:-db}"
PORT="${DB_PORT:-3306}"
USER="${DB_USER:-dissertation}"
TIMEOUT="${DB_WAIT_TIMEOUT:-120}"

# Resolve the password the same way the application does, so a deployment
# using Docker secrets does not have to configure it twice.
if [ -n "${DB_PASSWORD_FILE:-}" ]; then
  if [ ! -r "${DB_PASSWORD_FILE}" ]; then
    printf 'wait-for-db: cannot read DB_PASSWORD_FILE at %s\n' "${DB_PASSWORD_FILE}" >&2
    exit 1
  fi
  PASSWORD="$(cat "${DB_PASSWORD_FILE}")"
else
  PASSWORD="${DB_PASSWORD:-}"
fi

if ! command -v mysqladmin >/dev/null 2>&1; then
  printf 'wait-for-db: mysqladmin not found, skipping the wait\n' >&2
  exit 0
fi

# The password goes through the environment rather than the command line;
# arguments are visible to every process on the host via /proc.
MYSQL_PWD="${PASSWORD}"
export MYSQL_PWD

elapsed=0
while [ "${elapsed}" -lt "${TIMEOUT}" ]; do
  if mysqladmin ping --host="${HOST}" --port="${PORT}" --user="${USER}" \
      --connect-timeout=2 --silent >/dev/null 2>&1; then
    printf 'wait-for-db: %s:%s is ready\n' "${HOST}" "${PORT}" >&2
    exit 0
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

printf 'wait-for-db: gave up after %ss waiting for %s:%s\n' "${TIMEOUT}" "${HOST}" "${PORT}" >&2
exit 1
