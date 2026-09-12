# Updating a running deployment

This is the runbook for moving an installed instance to a newer revision
without losing anything. It assumes the Compose deployment described in
`README.md` — Unraid, a Linux host or a cloud VM; the steps are identical and
only the volume paths differ.

Read it once before your first update. The short version:

```sh
git pull --ff-only origin main
docker compose up -d --build
```

Everything else here is about doing that safely and knowing how to reverse it.

---

## Why the data survives a rebuild

Nothing durable lives in the image or in a container's own filesystem. Three
volumes hold everything, and `docker compose up -d --build` reattaches all
three to the containers it recreates:

| Volume     | Mounted at       | Holds                                  |
| ---------- | ---------------- | -------------------------------------- |
| `database` | `/var/lib/mysql` | Every content item, source and account |
| `files`    | `/data/files`    | Uploads, derivatives, build staging    |
| `backups`  | `/data/backups`  | Dumps and file archives                |

Destroying and recreating containers is the normal update path, not a risk to
those. Two further properties make the schema safe to move forward:

- **Applied migrations are immutable.** The runner stores a SHA-256 of every
  migration it applies and refuses to start if a file has changed since
  (`src/db/migrate.ts`). `.github/scripts/check-migrations.sh` fails any pull
  request that edits or deletes a migration already on `main`. An update can
  therefore only _add_ migrations on top of your schema; it cannot rewrite the
  ground your data sits on.
- **Migrations run once, from one role.** `scripts/entrypoint.sh` applies them
  from the `web` role only, and the Compose file sets `RUN_MIGRATIONS=false`
  on the worker. A MySQL named lock serialises runners besides, so containers
  starting together cannot double-apply.

> **`docker compose down -v` deletes the volumes.** That flag is the one way
> to lose the database through an ordinary-looking command. Plain
> `docker compose down` keeps them, and so does `up -d --build`. On Unraid,
> the equivalent mistake is deleting `/mnt/user/appdata/dissertation/mysql`
> while "cleaning up appdata".

---

## The runbook

Run everything from the directory holding `docker-compose.yml` and your
`.env` — over SSH on Unraid, or from the Compose Manager plugin's terminal.

**On Unraid, every command below needs the override file as well.**
`docker-compose.unraid.yml` is what points the three mounts at your array
paths. A `docker compose up -d --build` without it brings the containers up on
empty Docker-managed volumes instead — which looks exactly like losing the
database, and leaves the real one sitting untouched on the array. Set it once
for the session rather than trusting yourself to repeat a flag:

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.unraid.yml
```

### 1. Back up, and confirm the backup exists

Enqueue the job:

```sh
docker compose exec web /app/scripts/entrypoint.sh admin enqueue-backup
```

The worker picks it up on its next poll and writes `database-<stamp>.sql.gz`
and `files-<stamp>.tar.gz` to `BACKUP_ROOT`. It is asynchronous, so do not
move on until it has finished:

```sh
docker compose logs --tail 20 worker
ls -lh /mnt/user/backups/dissertation/
```

Wait for `wrote database backup` in the log — and `wrote file backup` unless
you passed `--no-files` — and for files of a plausible size to appear.

If the worker is not running, which is exactly when you are most likely to be
updating, dump directly instead:

```sh
docker compose exec -T db sh -c '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -u root \
    --single-transaction --quick --routines --triggers --events \
    --default-character-set=utf8mb4 --hex-blob --no-create-db "$MYSQL_DATABASE"
' | gzip > /mnt/user/backups/dissertation/pre-update-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

Those variables are expanded **inside the container**, where Compose set them;
a `$DB_ROOT_PASSWORD` written unquoted in your own shell expands to nothing,
because `.env` is read by Compose and not by your shell. The single quotes are
what keep the expansion on the right side of that line, and `MYSQL_PWD` keeps
the password out of the container's process list the same way
`scripts/wait-for-db.sh` does.

`--single-transaction` gives a consistent snapshot without locking the site
out; every table is InnoDB. `--default-character-set=utf8mb4` and `--hex-blob`
are not optional decoration: a charset mismatch anywhere along dump → restore
mangles Romanian diacritics silently. The backup belongs on a share the host
itself backs up: a copy sitting in the same appdata directory as the database
it protects is not a backup.

### 2. Record where you are

```sh
git rev-parse HEAD > /mnt/user/backups/dissertation/last-known-good.txt
docker compose exec web /app/scripts/entrypoint.sh migrate status
```

The first line is what you check out to roll back. The second tells you which
migration version you are rolling back _to_.

### 3. Pull, and read what changed

```sh
git pull --ff-only origin main
git diff HEAD@{1} HEAD -- .env.example db/migrations/
```

`.env` is gitignored, so your configuration and secrets are untouched by the
pull. But the application refuses to start on invalid configuration rather
than falling back to an unsafe default, so **a new required key in
`.env.example` is a failed boot if you do not add it to `.env` first.** The
same diff shows you which migrations are about to be applied.

### 4. Rebuild and restart

```sh
docker compose up -d --build
docker compose logs -f web
```

In the log you want, in order: `entrypoint: applying database migrations`, the
new versions being applied, then `entrypoint: starting web service`. The `db`
service is a pinned upstream image and is not rebuilt; only `web` and `worker`
come from this repository.

### 5. Verify

```sh
docker compose ps        # web reports (healthy)
docker compose exec web /app/scripts/entrypoint.sh migrate status
```

`web`'s health check queries the database through `/healthz`, so a healthy
container means the schema is reachable, not merely that a process started.
Then load a page, sign in, and confirm a private item is still private —
visibility is the property worth checking by hand after any change.

---

## Rolling back

Every up-migration has a tested down-migration; the runner refuses to load a
migration that lacks one. So a bad update reverses without touching the dump:

```sh
docker compose exec web /app/scripts/entrypoint.sh migrate down --to 8
git checkout "$(cat /mnt/user/backups/dissertation/last-known-good.txt)"
docker compose up -d --build
```

Use `--to <version>` from step 2 — the version you were on before, not the one
you are on now.

Restore from the dump only if a down-migration itself failed. MySQL commits
implicitly around DDL, so a migration that dies partway cannot undo itself,
and at that point the recorded schema version no longer describes the
database:

```sh
gunzip -c /mnt/user/backups/dissertation/database-<stamp>.sql.gz \
  | docker compose exec -T db sh -c \
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE"'
```

Then check out the revision that dump was taken on and rebuild. The file
archive restores by unpacking over `STORAGE_ROOT`; storage keys are content
hashes, so files and rows can be restored independently without going out of
step.

---

## Two changes that are not ordinary updates

**The MySQL major version.** `docker-compose.yml` pins `mysql:8.4`. MySQL
upgrades its data directory in place on first boot and cannot be downgraded
afterwards — starting a newer major version against your volume is a one-way
door. If an update bumps it, the safe path is a dump, a fresh empty volume and
a restore, not an in-place start. Nothing in this repository requires you to
move.

**`WEBAUTHN_RP_ID`.** Not a database concern, but the other irreversible one:
passkeys are bound to that domain, and changing it invalidates every
registered credential. Password plus a recovery code still gets you in, but
leave it alone across updates.

---

## Keeping backups running between updates

The backup job is enqueued, not scheduled — nothing in the container runs
cron. On Unraid, add the `INSERT` from step 1 to a User Scripts entry on a
nightly schedule; on another host, a host crontab line issuing the same
statement does the same thing. The job prunes to the newest `keep` of each
kind, so it will not fill the share.

A pre-update backup you took by hand should never be your only one.
