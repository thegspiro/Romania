#!/bin/sh
# Brings the database up through docker-compose.unraid.yml, on a bind mount.
#
# Separate from compose-smoke.sh because it tests a different thing: not that
# the stack works, but that it works when /var/lib/mysql is a bind mount owned
# by somebody else. That distinction is not academic. On a Docker-managed
# volume the data directory arrives already owned by mysql, the entrypoint's
# chown is a no-op, and the container starts happily without CAP_CHOWN -- so
# the base composition cannot notice that capability going missing. A bind
# mount can, and a bind mount is what this repository ships for Unraid.
#
# The paths are the ones in docker-compose.unraid.yml, verbatim. Creating them
# is the caller's job, because it needs root on the runner.
set -eu

DATADIR=/mnt/user/appdata/dissertation/mysql

[ -d "$DATADIR" ] || { printf 'compose-unraid: %s does not exist\n' "$DATADIR" >&2; exit 1; }

# Refuses an existing data directory rather than clearing it. Two reasons, and
# the second is the important one: MySQL applies MYSQL_ROOT_PASSWORD only at
# initialisation, so a second run cannot authenticate and fails confusingly --
# and this path is a real Unraid share. A script in this repository that
# deleted /mnt/user/appdata/dissertation/mysql would be one mistaken invocation
# away from destroying the database it exists to protect.
if [ -n "$(ls -A "$DATADIR" 2>/dev/null)" ]; then
  printf 'compose-unraid: %s is not empty. This check initialises a database and\n' "$DATADIR" >&2
  printf 'compose-unraid: will not touch existing data. Point it at an empty directory.\n' >&2
  exit 1
fi

before="$(stat -c '%u:%g' "$DATADIR")"
printf 'compose-unraid: %s starts owned by %s\n' "$DATADIR" "$before"

sed -e "s|^DB_PASSWORD=.*|DB_PASSWORD=ci-app-not-a-secret|" \
    -e "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=ci-root-not-a-secret|" \
    .env.example >.env

docker compose -f docker-compose.yml -f docker-compose.unraid.yml up -d db

i=0
while [ "$i" -lt 180 ]; do
  state="$(docker inspect -f '{{.State.Health.Status}}' dissertation-db-1 2>/dev/null || echo missing)"
  [ "$state" = "healthy" ] && break
  if [ "$(docker inspect -f '{{.State.Running}}' dissertation-db-1 2>/dev/null || echo false)" = "false" ]; then
    docker logs dissertation-db-1 2>&1 | tail -30 >&2
    printf 'compose-unraid: the database exited on a bind mount\n' >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done
[ "$state" = "healthy" ] || {
  docker logs dissertation-db-1 2>&1 | tail -30 >&2
  printf 'compose-unraid: the database never became healthy on a bind mount\n' >&2
  exit 1
}

# The chown is what needs CAP_CHOWN, so an unchanged owner would mean the
# capability was never exercised and this check proved nothing.
after="$(stat -c '%u:%g' "$DATADIR")"
[ "$after" != "$before" ] || {
  printf 'compose-unraid: owner is still %s -- the chown never happened, so this did not test CAP_CHOWN\n' "$after" >&2
  exit 1
}

printf 'compose-unraid: healthy after %ss; %s is now owned by %s\n' "$i" "$DATADIR" "$after"
