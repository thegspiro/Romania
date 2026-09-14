# Updating

This is the runbook for moving an installed instance to a newer revision
without losing anything. It assumes the Compose deployment from
[`installation.md`](installation.md) or [`unraid.md`](unraid.md) — Unraid, a
Linux host or a cloud VM. The steps are identical; only the volume paths
differ.

An update moves two things: the **compose files and `.env` template** in your
clone, and the **image**. Pull both — a new revision may change what the stack
expects of its configuration, and a compose file from three months ago paired
with today's image is a combination nobody tested.

Read this once before your first update. The short version:

```sh
git pull --ff-only origin main
docker compose pull && docker compose up -d
```

If you build locally rather than pull — which on Unraid is what running as uid
99 requires — the second line is `docker compose up -d --build` instead, and
`docker compose pull` does nothing useful.

Everything below is about doing that safely and knowing how to reverse it.

---

## Why the data survives a rebuild

Nothing durable lives in the image or in a container's own filesystem. Volumes
hold it, and `docker compose up -d` reattaches every one of them to the
containers it recreates — whether the new image was pulled or built:

| Volume           | Mounted at          | Holds                                  |
| ---------------- | ------------------- | -------------------------------------- |
| `database`       | `/var/lib/mysql`    | Every content item, source and account |
| `files`          | `/data/files`       | Uploads, derivatives, build staging    |
| `backups`        | `/data/backups`     | Dumps and file archives                |
| `tectonic-cache` | `/home/node/.cache` | TeX packages fetched for a PDF         |

The first three are yours. `tectonic-cache` is a cache — losing it costs a
re-download on the next compile, nothing more — and it is listed here only so
the inventory is complete.

> **With `STORAGE_BACKEND=s3` the `files` row is not where your files are.**
> They are in the bucket, and no part of this runbook puts them back. That
> changes the backup step below and the restore, so read the notes marked
> **Under S3** rather than the shorter path around them.

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

One more that decides how carefully to read a diff: **MySQL commits implicitly
around DDL**, so a migration that fails halfway cannot roll itself back.
Up-migrations here are written to be re-runnable for that reason, but the
recovery for a genuinely broken one is the backup. Which is why the backup
comes first.

> **`docker compose down -v` deletes the volumes.** That flag is the one way
> to lose the database through an ordinary-looking command. Plain
> `docker compose down` keeps them, and so does `up -d`. On Unraid,
> the equivalent mistake is deleting `/mnt/user/appdata/dissertation/mysql`
> while "cleaning up appdata".

---

## The runbook

Run everything from the directory holding `docker-compose.yml` and your
`.env` — over SSH on Unraid, or from the Compose Manager plugin's terminal.

### 1. Back up, and confirm the backup exists

```sh
docker compose exec web /app/scripts/entrypoint.sh admin enqueue-backup
```

That queues the job the worker performs. `--keep <n>` sets how many of each
kind to retain (default 14); `--no-files` backs up the database only. It
refuses to stack a second job while one is pending or running, and says so
rather than queueing another — so a nightly cron and a pre-update backup by
hand cannot end up holding two `mysqldump`s open at once.

The worker picks it up on its next poll and writes `database-<stamp>.sql.gz`
and `files-<stamp>.tar.gz` to `BACKUP_ROOT`. **It is asynchronous**, so do not
move on until it has finished — restarting the stack mid-dump kills the backup
you are relying on:

```sh
docker compose logs --tail=20 worker
docker compose exec web ls -lh /data/backups
```

Wait for `wrote database backup` in the log — and `wrote file backup` unless
you passed `--no-files` — and for files of a plausible size to appear. A file
still named `.partial` means the dump is mid-write; the job renames only after
a complete, successful one, so a partial file is never mistaken for a good
backup.

> **Under S3 there is no `wrote file backup`, and waiting for one will hang
> this step forever.** The job tars a directory, and an object store is not
> one; pulling a whole bucket of archival scans through the worker on every run
> would cost hours and egress. So it archives the database and says so in as
> many words:
>
> ```
> STORAGE_BACKEND is s3, so FILES WERE NOT ARCHIVED. This backup contains the
> database only. Protect the bucket with versioning and a lifecycle rule, ...
> ```
>
> That line is the success case, not a failure — `database-<stamp>.sql.gz` is
> still written to `BACKUP_ROOT`, which stays local either way. What it means
> is that **your files are protected by the bucket or not at all**: versioning,
> a lifecycle rule, or replication to a second bucket, arranged by you. Confirm
> that protection is in place before an update the same way you confirm the
> dump, because the restore below cannot put the bytes back for you.

If the worker is not running — which is exactly when you are most likely to be
updating — dump directly instead:

```sh
docker compose exec -T db sh -c '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -u root \
    --single-transaction --quick --routines --triggers --events \
    --default-character-set=utf8mb4 --hex-blob --no-create-db "$MYSQL_DATABASE"
' | gzip > /path/on/host/pre-update-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

Those variables expand **inside the container**, where Compose set them. A
`$DB_ROOT_PASSWORD` written in your own shell expands to nothing, because
`.env` is read by Compose and not by your shell — the single quotes are what
keep the expansion on the right side of that line. `MYSQL_PWD` keeps the
password out of the container's process list, the same way
`scripts/wait-for-db.sh` does.

`--single-transaction` gives a consistent snapshot without locking the site
out; every table is InnoDB. `--default-character-set=utf8mb4` and `--hex-blob`
are not decoration: a charset mismatch anywhere along dump → restore mangles
Romanian diacritics silently.

This is the one step here that still needs the database's root password;
`enqueue-backup` exists so the ordinary path does not.

**Copy the backup off the machine** if it is not already replicated. A copy
sitting in the same appdata directory as the database it protects is not a
backup.

### 2. Record where you are

```sh
git rev-parse HEAD > /path/on/host/last-known-good.txt
docker compose exec web /app/scripts/entrypoint.sh migrate status
```

The first line is what you check out to roll back. The second tells you which
migration version you are rolling back _to_ — note the highest `applied`
number before the update moves it.

### 3. Pull, and read what changed

```sh
git pull --ff-only origin main
git diff HEAD@{1} HEAD -- .env.example db/migrations/ docker-compose.yml
```

Three things in that diff decide how careful to be:

- **New migrations** (`db/migrations/NNNN_*.up.sql`) mean the schema moves.
  Read them.
- **Changes to `.env.example`** mean new or changed configuration. `.env` is
  gitignored, so your configuration and secrets are untouched by the pull —
  but the application refuses to start on invalid configuration rather than
  falling back to an unsafe default, so **a new required key in `.env.example`
  is a failed boot if you do not add it to `.env` first.** See
  [Configuration drift](#configuration-drift).
- **Changes to `docker-compose.yml`** conflict with any edits you made to that
  file directly. If you kept your changes in `docker-compose.override.yml`
  this is a non-issue.

If you edited `docker-compose.yml` in place — for example to delete the `db`
service for a managed database — the pull may conflict. Resolve it in favour
of keeping your deletion, and consider moving everything that _can_ live in
`docker-compose.override.yml` there so future pulls are clean.

### 4. Fetch the new image and restart

```sh
docker compose pull          # or: skip, and add --build below
docker compose up -d
docker compose logs -f web
```

In the log you want, in order: `entrypoint: applying database migrations`, the
new versions being applied, then `entrypoint: starting web service`.

The `db` service is a pinned upstream image and is not rebuilt or re-pulled by
this; only `web` and `worker` come from this repository.

`docker compose pull` with `IMAGE_TAG` unset follows `latest`, which moves with
every merge to `main`. If you pinned `IMAGE_TAG` to a `sha-` tag, raise it in
`.env` first — otherwise the pull re-fetches the tag you are already on and the
restart changes nothing, which reads like a failed update.

### 5. Verify

```sh
docker compose ps                                              # web reports (healthy)
docker compose run --rm web preflight
docker compose exec web /app/scripts/entrypoint.sh migrate status
```

`web`'s health check queries the database through `/healthz`, so a healthy
container means the schema is reachable, not merely that a process started.

Then, by hand:

- [ ] Load a page and sign in.
- [ ] A passkey still works — if it does not, check that `WEBAUTHN_RP_ID` did
      not change.
- [ ] **Confirm a private item is still private.** Visibility is the property
      worth checking by hand after any change.
- [ ] The worker is processing: `docker compose logs --tail=50 worker`.

---

## Looking before you leap

To inspect the schema change before it is applied rather than after, start the
web role with migrations disabled, look, then migrate deliberately:

```sh
RUN_MIGRATIONS=false docker compose up -d --build web
docker compose exec web /app/scripts/entrypoint.sh migrate status
docker compose exec web /app/scripts/entrypoint.sh migrate up
```

Worth doing when the diff in step 3 showed a migration that rewrites data
rather than only adding structure.

---

## Configuration drift

New releases add configuration, and nothing updates your `.env`. To find what
is new, diff against the template:

```sh
comm -23 \
  <(sed -n 's/^#\{0,1\} *\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env.example | sort -u) \
  <(sed -n 's/^ *\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env | sort -u)
```

That lists every variable the template mentions and your `.env` does not.
Commented-out optional settings in the template (`ZOTERO_*`, the `*_FILE`
forms, `DB_WAIT_TIMEOUT`) show up too, so read the list rather than pasting it
in wholesale.

Two are the exception, because they are **build** arguments rather than runtime
configuration: `APP_UID` and `APP_GID` decide the uid the containers run as and
are baked into the image. Changing either takes a `--build`, which step 4 does
anyway — but it does not move data already on disk. If you change them, chown
the bind-mounted directories to match in the same window, or the containers
will not be able to read what they wrote yesterday.

---

## Rolling back

Every up-migration has a tested down-migration — the runner refuses to load a
migration that lacks one (`src/db/migrate.ts`). So a bad update reverses
without touching the dump.

Rolling back means undoing **two** things, the code and the schema, and the
order matters:

> **Roll the schema back first, while the new code is still checked out.**
>
> `migrate down` reads the down-migration files from `db/migrations/`. If you
> check out the old commit first, the files for the new migrations are gone
> from the working tree, and the runner refuses:
> `Version N is recorded as applied but its files are missing from
db/migrations. Restore them before rolling back.`

```sh
# 1. Still on the new code. --to is the version from step 2 -- the one you
#    were on BEFORE the update, not the one you are on now.
docker compose exec web /app/scripts/entrypoint.sh migrate down --to 13

# 2. Now go back to the old revision.
git checkout "$(cat /path/on/host/last-known-good.txt)"

#    Pin the image to that same commit and pull it, rather than rebuilding:
#    every published commit carries an immutable sha- tag, so the rollback
#    fetches the exact artifact that was running before.
printf 'IMAGE_TAG=sha-%s\n' "$(git rev-parse --short=12 HEAD)" >> .env
docker compose pull && docker compose up -d

#    Building locally instead? Then it is `docker compose up -d --build`, and
#    IMAGE_TAG is irrelevant.

# 3. Confirm.
docker compose run --rm web preflight
```

Pinning is worth doing even if you were following `latest`: it stops the next
`docker compose pull` from silently carrying you forward again to the revision
you just rolled back from. Remove the line from `.env` when you roll forward
deliberately.

Step 1 needs a running `web` container. If the new version will not start at
all, use `run` instead, which does not need a healthy service:

```sh
docker compose run --rm web migrate down --to 13
```

Restore from the dump only if a down-migration itself failed. MySQL commits
implicitly around DDL, so a migration that dies partway cannot undo itself, and
at that point the recorded schema version no longer describes the database.

---

## Restoring from a backup

The full recovery path, for when rolling back is not enough. This **replaces**
the live database and files.

Before you start, know which backup you are restoring and that you can afford
to lose everything written since it was taken. Check out the application code
that matches the backup — `last-known-good.txt`, or the revision the dump was
taken on — before step 4.

```sh
# 1. Stop the application, but leave the database running.
docker compose stop web worker

# 2. Restore the database.
docker compose exec -T db sh -c '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root -e "
    DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`;
    CREATE DATABASE \`$MYSQL_DATABASE\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"'

gzip -dc /path/on/host/to/database-20260912T031500Z.sql.gz \
  | docker compose exec -T db sh -c \
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE"'
```

The character set matters: the corpus contains Romanian diacritics, and a
mismatch anywhere along dump → restore mangles them silently. That is exactly
what the restore rehearsal checks for.

```sh
# 3. Restore the files. The archive holds a top-level `files/` directory,
#    so strip it and extract into STORAGE_ROOT.
docker compose run --rm -T web \
  sh -c 'tar -xz --strip-components=1 -C /data/files' \
  < /path/on/host/to/files-20260912T031500Z.tar.gz

# 4. Bring it back up and check.
docker compose up -d
docker compose run --rm web preflight
```

Storage keys are content hashes, so files and rows can be restored
independently without going out of step — a database restored from one stamp
and files from another still agree about which bytes a record names.

> **Under S3, skip step 3 — there is no archive to extract.** The bytes were
> never in `files-<stamp>.tar.gz`, so recovering them is a bucket operation and
> not one this runbook can perform for you: restore the object versions, or
> promote the replica, with whichever protection you arranged when you turned
> the backend on.
>
> Restore the database anyway. The property above is what makes that safe to do
> on its own — a key is a content hash, so rows recovered to one point in time
> and objects recovered to another still name the same bytes. What you get if
> the bucket is further behind than the dump is a record whose file is missing,
> which reads as a 404 on that one item rather than a corpus that disagrees
> with itself.
>
> `admin storage migrate` is not a restore. It copies what the database already
> knows about into the configured backend; it cannot recover an object the
> bucket no longer holds.

> **Rehearse this before you need it.** `scripts/restore-rehearsal.sh` runs the
> whole drill against a scratch database — see the README's
> [Rehearsing a restore](../README.md#rehearsing-a-restore). CI runs it on every
> pull request. A backup nobody has restored is a hypothesis.

---

## Three changes that are not ordinary updates

**The MySQL major version.** `docker-compose.yml` pins `mysql:8.4`. MySQL
upgrades its data directory in place on first boot and cannot be downgraded
afterwards — starting a newer major version against your volume is a one-way
door. If an update bumps it, the safe path is a dump, a fresh empty volume and
a restore, not an in-place start. Nothing in this repository requires you to
move.

**`WEBAUTHN_RP_ID`.** Not a database concern, but the other irreversible one:
passkeys are bound to that domain, and changing it invalidates every registered
credential. Password plus a recovery code still gets you in, but leave it alone
across updates.

**The pinned base images.** Base images are pinned by digest in `Dockerfile`
and `docker-compose.yml`, so a rebuild produces the image CI validated rather
than whatever the tag points at today. The cost is that base security updates
do not arrive on their own — refresh them deliberately:

```sh
docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect mysql:8.4 --format '{{.Manifest.Digest}}'
```

Use the multi-arch index digest, not a per-platform one: the CI matrix builds
`linux/amd64` and `linux/arm64` from the same reference. The MySQL digest
appears in more than one place — `docker-compose.yml` and one service container
per CI job — and `.github/scripts/check-invariants.mjs` fails the build if any
occurrence is unpinned or if they diverge, so update them together. This is a
change to tracked files, so it belongs in a commit rather than a local edit the
next `git pull` will fight with.

---

## Keeping backups running between updates

The backup job is enqueued, not scheduled — nothing in the container runs cron.
Put the command from step 1 on a schedule the host keeps: a User Scripts entry
on Unraid, a crontab line anywhere else.

```sh
cd /path/to/the/clone && docker compose exec -T web \
  /app/scripts/entrypoint.sh admin enqueue-backup --keep 14
```

`-T` because cron has no TTY. The job prunes to the newest `keep` of each kind,
so it will not fill the share, and `enqueue-backup` declines to stack a second
job while one is still running — so a nightly entry firing during a long dump
is harmless.

A pre-update backup you took by hand should never be your only one.

---

## On Unraid

Nothing above changes, with three notes:

- Run it from the clone (`/mnt/user/appdata/dissertation/repo` in
  [`unraid.md`](unraid.md)), not from a Compose Manager project directory on
  the flash drive.
- Pass the Unraid overlay on every command —
  `-f docker-compose.yml -f docker-compose.unraid.yml`, or set `COMPOSE_FILE`
  once as [`unraid.md`](unraid.md) shows. A rebuild that forgets it points the
  stack back at the named volumes, and the site returns looking empty because
  it is talking to a different, blank database.
- Ownership does not need re-applying unless you have run Docker Safe New
  Permissions since the last start.

## When the database is managed elsewhere

The rebuild is the same. The backup and the restore need your own client rather
than `docker compose exec db`, and the restore's `DROP DATABASE` may not be
permitted to the application's user — use an administrative account, the same
way `scripts/restore-rehearsal.sh` takes `REHEARSAL_DB_USER` for exactly this
reason.

Snapshots of the managed instance are a complement to the job-based backup, not
a replacement: the dump is what the restore rehearsal exercises, and it is the
one that has been proven to read back.
