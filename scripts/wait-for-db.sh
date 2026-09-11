#!/bin/sh
#
# Blocks until MySQL accepts the application's own credentials, or gives up.
#
# Deliberately NOT `mysqladmin ping`. The MySQL manual is explicit that ping
# exits 0 on Access denied, "because this means that the server is running but
# refused the connection, which is different from the server not running" -- so
# a wrong DB_PASSWORD sailed straight through the wait and surfaced several
# layers later, in the migration runner, as something that read like a
# migration problem.
#
# What every caller of this script actually assumes is that it can connect to
# DB_NAME as DB_USER. That is what is tested here, so the wait either proves it
# or says exactly what failed.
set -eu

HOST="${DB_HOST:-db}"
PORT="${DB_PORT:-3306}"
USER="${DB_USER:-dissertation}"
NAME="${DB_NAME:-dissertation}"
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

if ! command -v mysql >/dev/null 2>&1; then
  printf 'wait-for-db: mysql client not found, skipping the wait\n' >&2
  exit 0
fi

# The password goes through the environment rather than the command line;
# arguments are visible to every process on the host via /proc.
MYSQL_PWD="${PASSWORD}"
export MYSQL_PWD

elapsed=0
failure=''
while [ "${elapsed}" -lt "${TIMEOUT}" ]; do
  # 2>&1 >/dev/null keeps the client's diagnostics and discards the result set:
  # the redirections are applied left to right, so stderr goes to the captured
  # stdout and the SELECT's own output is dropped.
  if failure="$(mysql --host="${HOST}" --port="${PORT}" --user="${USER}" \
      --database="${NAME}" --connect-timeout=2 \
      --execute='SELECT 1' 2>&1 >/dev/null)"; then
    printf 'wait-for-db: %s:%s/%s accepted the application credentials\n' \
      "${HOST}" "${PORT}" "${NAME}" >&2
    exit 0
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

printf 'wait-for-db: gave up after %ss connecting to %s:%s/%s as "%s"\n' \
  "${TIMEOUT}" "${HOST}" "${PORT}" "${NAME}" "${USER}" >&2
if [ -n "${failure}" ]; then
  # Access denied and unknown database both land here, and both are
  # configuration mistakes rather than something to wait longer for.
  printf 'wait-for-db: last error was: %s\n' "${failure}" >&2
fi
exit 1
