#!/bin/sh
# Brings the composition up and asserts what only a running stack can show.
#
# Every other job tests a piece: the image in isolation, the application
# against a service container, the schema against a scratch database. None of
# them runs docker-compose.yml, which is the file an operator actually deploys
# -- so entrypoint ordering, the health checks, the capability sets and which
# secrets each container ends up holding were verified by hand and then never
# again. Each of those has already been wrong once.
#
# Assumes dissertation-platform:latest is already built and loaded, and starts
# the stack with --no-build so this does not repeat the `docker` job's work.
set -eu

COMPOSE="docker compose"
PASS=0

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
die() { printf '  FAIL %s\n' "$1" >&2; exit 1; }

# --- configuration ----------------------------------------------------------
#
# Derived from .env.example rather than written out here, so a new required
# setting reaches this job the same way it reaches an operator: by being in the
# file they are told to copy. Only the values that must not be the shipped
# placeholders are replaced.
# Fixed throwaway values, like the ones already in ci.yml. Deriving them from
# the clock looked tidier and is wrong: MySQL applies MYSQL_ROOT_PASSWORD only
# when it initialises the data directory, so a second run against an existing
# one authenticates with a password the database has never heard of, and the
# health check fails while the server sits there perfectly happy.
write_env() {
  sed \
    -e "s|^DB_PASSWORD=.*|DB_PASSWORD=ci-app-not-a-secret|" \
    -e "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=ci-root-not-a-secret|" \
    .env.example >.env
}

wait_healthy() {
  container="$1"
  limit="${2:-180}"
  i=0
  while [ "$i" -lt "$limit" ]; do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)"
    [ "$state" = "healthy" ] && { ok "$container healthy after ${i}s"; return 0; }
    running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)"
    if [ "$running" = "false" ]; then
      printf '  --- %s exited ---\n' "$container" >&2
      docker logs "$container" 2>&1 | tail -30 >&2
      die "$container exited before becoming healthy"
    fi
    i=$((i + 1))
    sleep 1
  done
  printf '  --- %s never became healthy ---\n' "$container" >&2
  docker logs "$container" 2>&1 | tail -30 >&2
  die "$container did not become healthy within ${limit}s"
}

# --- the stack --------------------------------------------------------------
write_env
$COMPOSE up -d --no-build

# web being healthy is the entrypoint's whole sequence passing: wait-for-db
# proving the application credentials work, check-storage proving the data
# directories are writable, the migrations applying, and the server answering
# its own /healthz.
wait_healthy dissertation-db-1
wait_healthy dissertation-web-1

[ "$(docker inspect -f '{{.State.Running}}' dissertation-worker-1)" = "true" ] \
  || die "worker is not running"
ok "worker is running"

# --- capabilities -----------------------------------------------------------
#
# Asserted on the running container, not read back out of the YAML. The set for
# db was established by removing each one and watching MySQL fail; this is what
# notices if a future edit trims it back.
caps="$(docker inspect -f '{{.HostConfig.CapAdd}}' dissertation-db-1)"
for cap in CAP_CHOWN CAP_DAC_OVERRIDE CAP_SETGID CAP_SETUID; do
  case "$caps" in *"$cap"*) ;; *) die "db is missing $cap (has: $caps)" ;; esac
done
ok "db holds exactly the four capabilities it needs"

for service in web worker db; do
  dropped="$(docker inspect -f '{{.HostConfig.CapDrop}}' "dissertation-${service}-1")"
  case "$dropped" in *ALL*) ;; *) die "$service does not drop ALL (has: $dropped)" ;; esac
done
ok "web, worker and db all drop ALL first"

# --- secrets the web container must not hold --------------------------------
#
# check-invariants.mjs asserts this against the compose file. This asserts it
# against the process, which is where it actually matters and where an
# `environment:` entry that looks like an unset but is not would show up.
for name in DB_ROOT_PASSWORD ZOTERO_API_KEY; do
  value="$(docker exec dissertation-web-1 printenv "$name" 2>/dev/null || true)"
  [ -z "$value" ] || die "web holds a value for $name"
done
ok "web holds no value for DB_ROOT_PASSWORD or ZOTERO_API_KEY"

value="$(docker exec dissertation-web-1 printenv DB_PASSWORD 2>/dev/null || true)"
[ -n "$value" ] || die "web lost DB_PASSWORD, which it does need"
ok "web still holds DB_PASSWORD, which it does need"

# --- the operator's own commands --------------------------------------------
$COMPOSE exec -T web /app/scripts/entrypoint.sh preflight >/tmp/preflight.out 2>&1 \
  || { cat /tmp/preflight.out >&2; die "preflight reported the install as not ready"; }
grep -q 'administrator' /tmp/preflight.out || die "preflight did not report on the administrator"
ok "preflight exits clean and reports every check"

$COMPOSE exec -T web /app/scripts/entrypoint.sh admin enqueue-backup --keep 7 >/tmp/backup.out 2>&1 \
  || { cat /tmp/backup.out >&2; die "enqueue-backup failed"; }
grep -q 'keeping the newest 7' /tmp/backup.out || { cat /tmp/backup.out >&2; die "enqueue-backup did not honour --keep"; }

$COMPOSE exec -T web /app/scripts/entrypoint.sh admin enqueue-backup >/tmp/backup2.out 2>&1 || true
grep -q 'already queued' /tmp/backup2.out \
  || { cat /tmp/backup2.out >&2; die "a second backup request was not refused"; }
ok "enqueue-backup queues one job and refuses to stack a second"

# --- the site actually answers ----------------------------------------------
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8080/)"
[ "$code" = "200" ] || die "the public site answered $code"
ok "the public site answers 200 on the published port"

curl -fsS --max-time 10 http://127.0.0.1:8080/robots.txt | grep -q 'Disallow: /' \
  || die "robots.txt does not disallow crawling with ALLOW_SEARCH_INDEXING=false"
ok "robots.txt disallows everything by default"

printf '\ncompose smoke test passed (%s assertions)\n' "$PASS"
