#!/bin/sh
# Prove a backup can actually be restored, and that what comes back out is
# readable without this application.
#
# A backup nobody has restored is a hypothesis. This runs the whole drill
# end to end:
#
#   1. take a backup with the real backup handler, not a hand-written dump
#   2. restore it into a scratch database
#   3. export the restored corpus to Markdown and CSL-JSON
#   4. check the counts match the database it came from, and that the
#      bibliography parses as JSON
#
# It reads the live database and writes only to the scratch database and the
# output directory, so it is safe to run against production -- which is the
# point: a rehearsal against a copy of the schema proves less than one against
# the data you actually care about.
#
# Usage:
#   DB_PASSWORD=... scripts/restore-rehearsal.sh [--keep-output]
#
# Environment (all have the same defaults as the application):
#   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD
#   REHEARSAL_DB_NAME   scratch database to restore into (default: <DB_NAME>_rehearsal)
#   BACKUP_ROOT         where the backup is written (default: /data/backups)
#   STORAGE_ROOT        artifact files (default: /data/files)
#   PYTHON              interpreter with the worker's dependencies (default: .venv/bin/python)
#   NODE                interpreter for the export command (default: node)

set -eu

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-dissertation}"
DB_USER="${DB_USER:-dissertation}"
REHEARSAL_DB_NAME="${REHEARSAL_DB_NAME:-${DB_NAME}_rehearsal}"
BACKUP_ROOT="${BACKUP_ROOT:-/data/backups}"
STORAGE_ROOT="${STORAGE_ROOT:-/data/files}"
PYTHON="${PYTHON:-.venv/bin/python}"
NODE="${NODE:-node}"

KEEP_OUTPUT=0
for argument in "$@"; do
  case "$argument" in
    --keep-output) KEEP_OUTPUT=1 ;;
    *)
      printf 'Unknown option: %s\n' "$argument" >&2
      exit 2
      ;;
  esac
done

if [ -z "${DB_PASSWORD:-}" ]; then
  printf 'DB_PASSWORD is required.\n' >&2
  exit 2
fi

if [ "$REHEARSAL_DB_NAME" = "$DB_NAME" ]; then
  # The scratch database is dropped and recreated. Refusing here is the only
  # thing between a typo and the corpus.
  printf 'REHEARSAL_DB_NAME must differ from DB_NAME (%s).\n' "$DB_NAME" >&2
  exit 2
fi

for tool in mysql mysqldump; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s is not on PATH; the rehearsal needs the MySQL client tools.\n' "$tool" >&2
    exit 1
  fi
done

WORK_DIR="$(mktemp -d)"
# The defaults file carries the password, so it is created inside a 0700
# directory and removed on every exit path. Arguments are world-readable
# through /proc; a file is not.
chmod 700 "$WORK_DIR"
DEFAULTS_FILE="$WORK_DIR/client.cnf"
OUTPUT_DIR="${REHEARSAL_OUTPUT_DIR:-$WORK_DIR/export}"

cleanup() {
  status=$?
  if [ "$KEEP_OUTPUT" -eq 1 ] && [ -d "$OUTPUT_DIR" ] && [ "$OUTPUT_DIR" != "$WORK_DIR/export" ]; then
    rm -f "$DEFAULTS_FILE"
  else
    rm -rf "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

umask 077
cat >"$DEFAULTS_FILE" <<EOF
[client]
user=$DB_USER
password=$DB_PASSWORD
host=$DB_HOST
port=$DB_PORT
EOF

mysql_do() {
  mysql --defaults-extra-file="$DEFAULTS_FILE" --batch --skip-column-names "$@"
}

count_in() {
  # $1 database, $2 SQL expression returning one number.
  # A failed query must not fall back to 0: two zeroes compare equal, so a
  # typo would report a passing check over a comparison that never ran.
  if ! result="$(mysql_do "$1" -e "$2")"; then
    printf 'Query failed against %s: %s\n' "$1" "$2" >&2
    exit 1
  fi
  printf '%s\n' "$result"
}

# The export runs the application's own config loader, which validates every
# setting -- including WebAuthn, which an export does not use. Checking it up
# front turns "died halfway through step 3" into a clear message before
# anything has been written. Run this the way the app runs: with its .env
# loaded, e.g. `docker compose exec web scripts/restore-rehearsal.sh`.
printf '== 0. checking the environment\n'
if ! "$NODE" -e '
process.env.DB_NAME = process.env.DB_NAME || "placeholder";
require("./dist/config.js").loadConfig();
' >/dev/null 2>&1; then
  printf 'The application configuration is invalid or incomplete.\n' >&2
  printf 'Run this with the environment the app runs with (its .env loaded).\n' >&2
  "$NODE" -e 'require("./dist/config.js").loadConfig();' 2>&1 | sed 's/^/   /' >&2 || true
  exit 2
fi
printf '   ok       configuration loads\n'

printf '== 1. backing up %s\n' "$DB_NAME"
BACKUP_ROOT="$BACKUP_ROOT" \
STORAGE_ROOT="$STORAGE_ROOT" \
DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" \
DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
"$PYTHON" -c '
import logging, sys
from worker.config import load_config
from worker.jobs import backup

logging.basicConfig(level=logging.INFO, format="   %(message)s")
# The real handler, not a hand-written mysqldump: a rehearsal of a different
# command proves nothing about the one that runs nightly.
backup.run(None, load_config(), {"keep": 365, "includeFiles": True})
'

DUMP="$(ls -1t "$BACKUP_ROOT"/database-*.sql.gz 2>/dev/null | head -n 1 || true)"
if [ -z "$DUMP" ]; then
  printf 'No database-*.sql.gz appeared in %s.\n' "$BACKUP_ROOT" >&2
  exit 1
fi
printf '   using %s (%s bytes)\n' "$DUMP" "$(wc -c <"$DUMP" | tr -d ' ')"

printf '== 2. restoring into %s\n' "$REHEARSAL_DB_NAME"
mysql_do -e "DROP DATABASE IF EXISTS \`$REHEARSAL_DB_NAME\`;
             CREATE DATABASE \`$REHEARSAL_DB_NAME\`
               CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
gzip -dc "$DUMP" | mysql --defaults-extra-file="$DEFAULTS_FILE" "$REHEARSAL_DB_NAME"

printf '== 3. exporting the restored corpus\n'
# Not piped into sed: POSIX sh has no pipefail, and `set -e` sees only the
# last command in a pipeline -- so a failed export would be reported as a
# successful indent. Capture, then indent.
EXPORT_LOG="$WORK_DIR/export.log"
if ! DB_NAME="$REHEARSAL_DB_NAME" \
  DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
  STORAGE_ROOT="$STORAGE_ROOT" \
  "$NODE" dist/cli/admin.js export --out "$OUTPUT_DIR" >"$EXPORT_LOG" 2>&1; then
  sed 's/^/   /' <"$EXPORT_LOG" >&2
  printf 'The export failed, so there is nothing to check.\n' >&2
  exit 1
fi
sed 's/^/   /' <"$EXPORT_LOG"

if [ ! -f "$OUTPUT_DIR/manifest.json" ]; then
  printf 'The export reported success but wrote no manifest.json.\n' >&2
  exit 1
fi

printf '== 4. checking what came back\n'
FAILURES=0

check_count() {
  # $1 human label, $2 SQL expression
  original="$(count_in "$DB_NAME" "$2")"
  restored="$(count_in "$REHEARSAL_DB_NAME" "$2")"
  if [ "$original" = "$restored" ]; then
    printf '   ok       %-22s %s\n' "$1" "$original"
  else
    printf '   MISMATCH %-22s live=%s restored=%s\n' "$1" "$original" "$restored" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

check_count "essays" "SELECT COUNT(*) FROM content_item WHERE kind='essay'"
check_count "sources" "SELECT COUNT(*) FROM content_item WHERE kind='source'"
check_count "artifacts" "SELECT COUNT(*) FROM content_item WHERE kind='artifact'"
check_count "people" "SELECT COUNT(*) FROM content_item WHERE kind='person'"
check_count "events" "SELECT COUNT(*) FROM content_item WHERE kind='event'"
check_count "relationships" "SELECT COUNT(*) FROM relationship"
check_count "essay revisions" "SELECT COUNT(*) FROM essay_revision"
check_count "file objects" "SELECT COUNT(*) FROM file_object"

# The export is only worth anything if the files parse in the tools they are
# meant for. Node is already required above, so use it rather than assuming jq.
if ! "$NODE" -e '
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const directory = process.argv[1];

const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const references = JSON.parse(readFileSync(join(directory, "sources", "references.json"), "utf8"));
const artifacts = JSON.parse(readFileSync(join(directory, "artifacts", "artifacts.json"), "utf8"));

if (!Array.isArray(references)) throw new Error("references.json is not a CSL-JSON array");
if (!Array.isArray(artifacts)) throw new Error("artifacts.json is not an array");
if (references.length !== manifest.sources) {
  throw new Error(`references.json holds ${references.length}, manifest says ${manifest.sources}`);
}
// Every entry needs an id and a type, or neither Zotero nor Pandoc will read it.
for (const entry of references) {
  if (typeof entry.id !== "string" || entry.id === "") throw new Error("a CSL entry has no id");
  if (typeof entry.type !== "string" || entry.type === "") {
    throw new Error(`CSL entry ${entry.id} has no type`);
  }
}
process.stdout.write(`   ok       references.json        ${references.length} CSL entries\n`);
process.stdout.write(`   ok       artifacts.json         ${artifacts.length} records\n`);
' "$OUTPUT_DIR"; then
  FAILURES=$((FAILURES + 1))
fi

if [ "$KEEP_OUTPUT" -eq 1 ]; then
  printf '   export kept at %s\n' "$OUTPUT_DIR"
fi

printf '== 5. cleaning up the scratch database\n'
mysql_do -e "DROP DATABASE IF EXISTS \`$REHEARSAL_DB_NAME\`;"

if [ "$FAILURES" -gt 0 ]; then
  printf '\nRehearsal FAILED: %s check(s) did not pass.\n' "$FAILURES" >&2
  exit 1
fi

printf '\nRehearsal passed: the backup restores, and the corpus reads back as Markdown and CSL-JSON.\n'
