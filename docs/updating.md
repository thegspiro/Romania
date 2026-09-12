# Updating

An update here is a **rebuild from source**, not an image pull. There is no
published container image, so `docker compose pull` has nothing to fetch — the
clone you installed from is the build context, and updating means pulling into
it and rebuilding.

This page assumes the install described in [`installation.md`](installation.md)
or [`unraid.md`](unraid.md).

---

## What an update actually does

```
git pull                      new application code
docker compose up -d --build  rebuild the image, recreate the containers
                              └─ web starts, applies pending migrations,
                                 then serves
```

Two consequences worth knowing before you run it:

- **Migrations apply themselves.** The `web` role runs `migrate up` on start
  unless `RUN_MIGRATIONS=false`. By the time the new container is serving, the
  schema has already moved. You do not get a chance to inspect the change
  between the pull and the migration unless you ask for one — see
  [Looking before you leap](#looking-before-you-leap).
- **Only `web` migrates.** The compose file sets `RUN_MIGRATIONS=false` on the
  worker so the two roles never race.

And one that is easy to miss: **MySQL commits implicitly around DDL**, so a
migration that fails halfway cannot roll itself back. Up-migrations in this
repository are written to be re-runnable for that reason, but the recovery for
a genuinely broken one is the backup. Which is why the backup comes first.

---

## 1. Back up, and wait for it to finish

```sh
docker compose exec db mysql -u root -p"$DB_ROOT_PASSWORD" dissertation \
  -e "INSERT INTO job (kind, payload) VALUES ('backup.run', '{\"keep\": 14}')"
```

> If you run the database elsewhere — RDS, Cloud SQL — there is no `db`
> service to exec into. Connect with your own client and run the same
> `INSERT`, or use the web container's MySQL client:
> `docker compose exec web mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" -e "…"`.

**This is asynchronous.** The statement enqueues a job; the worker picks it up
on its next poll and a dump of a real corpus takes minutes. Restarting the
stack while that runs kills the backup you are relying on.

Wait for it:

```sh
docker compose exec db mysql -u root -p"$DB_ROOT_PASSWORD" dissertation \
  -e "SELECT id, state, attempts, last_error FROM job WHERE kind='backup.run' ORDER BY id DESC LIMIT 1"
```

Wait until `state` is `succeeded`. Then confirm the files landed:

```sh
docker compose exec web ls -l /data/backups
```

You are looking for a `database-<timestamp>.sql.gz` and a
`files-<timestamp>.tar.gz` with recent timestamps. A file still named
`.partial` means the backup is mid-write — the job renames only after a
complete, successful dump, so a partial file is never mistaken for a good one.

**Copy the backup off the machine** before continuing if it is not already
replicated. A backup on the host you are about to change is only half a backup.

## 2. Look at what is coming

```sh
git fetch origin
git log --oneline HEAD..origin/main
git diff HEAD..origin/main -- db/migrations/ .env.example docker-compose.yml
```

Three things in that diff decide how careful to be:

- **New migrations** (`db/migrations/NNNN_*.up.sql`) mean the schema moves.
  Read them. Note the highest version number already applied — you need it to
  roll back, and `docker compose exec web /app/scripts/entrypoint.sh migrate
status` prints it.
- **Changes to `.env.example`** mean new or changed configuration. Nothing
  copies them into your `.env`; see [Configuration drift](#configuration-drift).
- **Changes to `docker-compose.yml`** conflict with any edits you made to that
  file directly. If you kept your changes in `docker-compose.override.yml` this
  is a non-issue.

## 3. Pull and rebuild

```sh
git pull
docker compose up -d --build
```

If you edited `docker-compose.yml` in place — for example to delete the `db`
service for a managed database — the pull may conflict. Resolve it in favour of
keeping your deletion, and consider moving everything that _can_ live in
`docker-compose.override.yml` there so future pulls are clean.

Watch the migrations run:

```sh
docker compose logs -f web
```

## 4. Verify

```sh
docker compose run --rm web preflight
```

Then:

- [ ] `docker compose ps` shows `web`, `worker` and `db` healthy.
- [ ] `migrations` reads `all N applied`.
- [ ] The site loads and you can sign in.
- [ ] A passkey still works — if it does not, check that `WEBAUTHN_RP_ID` did
      not change.
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

Worth doing when the diff in step 2 showed a migration that rewrites data
rather than only adding structure.

---

## Configuration drift

New releases add configuration. Your `.env` is a copy taken at install time and
nothing updates it, so the way to find what is new is to diff against the
template:

```sh
comm -23 \
  <(sed -n 's/^#\{0,1\} *\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env.example | sort -u) \
  <(sed -n 's/^ *\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env | sort -u)
```

That lists every variable the template mentions and your `.env` does not.
Commented-out optional settings in the template (`ZOTERO_*`, the `*_FILE`
forms, `DB_WAIT_TIMEOUT`) show up too, so read the list rather than pasting it
in wholesale.

Most values have safe defaults, and the application validates the whole
configuration at startup and refuses to start if something required is missing
— so a genuinely necessary value fails loudly rather than silently.

---

## Rolling back

Rolling back an update means undoing **two** things: the code and the schema.
The order matters, and it is not the obvious one.

> **Roll the schema back first, while the new code is still checked out.**
>
> `migrate down` reads the down-migration files from `db/migrations/`. If you
> check out the old commit first, the files for the new migrations are gone
> from the working tree, and the runner refuses:
> `Version N is recorded as applied but its files are missing from
db/migrations. Restore them before rolling back.`

So:

```sh
# 1. Still on the new code. Roll the schema back to the version you noted
#    in step 2 — every migration above it is reverted.
docker compose exec web /app/scripts/entrypoint.sh migrate down --to 13

# 2. Now go back to the old code and rebuild.
git checkout <the-previous-commit>
docker compose up -d --build

# 3. Confirm.
docker compose run --rm web preflight
```

Step 1 needs a running `web` container. If the new version will not start at
all, use `run` instead, which does not need a healthy service:

```sh
docker compose run --rm web migrate down --to 13
```

If a migration failed partway through and left the schema in a state its own
down-migration cannot undo — possible, because MySQL commits around DDL — stop
and restore from the backup instead.

---

## Restoring from a backup

The full recovery path, for when rolling back is not enough. This **replaces**
the live database and files.

Before you start, know which backup you are restoring and that you can afford
to lose everything written since it was taken.

```sh
# 1. Stop the application, but leave the database running.
docker compose stop web worker

# 2. Restore the database. Adjust the timestamp to the backup you want.
docker compose exec db sh -c '
  mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "
    DROP DATABASE IF EXISTS \`dissertation\`;
    CREATE DATABASE \`dissertation\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"'

gzip -dc /path/on/host/to/database-20260912T031500Z.sql.gz \
  | docker compose exec -T db sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" dissertation'
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

Check out the application code that matches the backup's schema before step 4.
A dump restored under newer code whose migrations have not run is a schema the
application does not expect; `migrate status` will show them pending and the
`web` role will apply them on start.

> **Rehearse this before you need it.** `scripts/restore-rehearsal.sh` runs the
> whole drill against a scratch database — see the README's
> [Rehearsing a restore](../README.md#rehearsing-a-restore). CI runs it on every
> pull request. A backup nobody has restored is a hypothesis.

---

## Refreshing the base images

Base images are pinned by digest in `Dockerfile` and `docker-compose.yml`, so a
rebuild produces the image CI validated rather than whatever the tag points at
today. The cost is that base security updates do not arrive on their own —
refresh them deliberately:

```sh
docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect mysql:8.4 --format '{{.Manifest.Digest}}'
```

Use the multi-arch index digest, not a per-platform one: the CI matrix builds
`linux/amd64` and `linux/arm64` from the same reference.

The MySQL digest appears in more than one place — `docker-compose.yml` and one
service container per CI job. `.github/scripts/check-invariants.mjs` fails the
build if any occurrence is unpinned or if they diverge, so update them together.

This is a change to tracked files, so it belongs in a commit rather than in a
local edit that the next `git pull` will fight with.

---

## On Unraid

Nothing above changes, with two notes:

- Run it from the clone (`/mnt/user/appdata/dissertation/repo` in
  [`unraid.md`](unraid.md)), not from a Compose Manager project directory on
  the flash drive.
- Your `docker-compose.override.yml` is gitignored, so the pull will not touch
  your bind mounts. Ownership does not need re-applying unless you have run
  Docker Safe New Permissions since the last start.

## When the database is managed elsewhere

The rebuild is the same. The backup enqueue and the restore need your own
client rather than `docker compose exec db`, and the restore's `DROP DATABASE`
may not be permitted to the application's user — use an administrative account,
the same way `scripts/restore-rehearsal.sh` takes `REHEARSAL_DB_USER` for
exactly this reason.

Snapshots of the managed instance are a complement to the job-based backup, not
a replacement: the dump is what the restore rehearsal exercises, and it is the
one that has been proven to read back.
