# Installing on Unraid

Unraid is a first-class target for this application — the job queue is a MySQL
table rather than Redis specifically so there is one fewer service to run here.
But the install does not look like a normal Unraid install, and two things
about it will bite you if nobody says them first.

Read [`installation.md`](installation.md) for what the configuration values
mean. This page covers what is different on Unraid.

---

## What will not work

> **There is no published container image.** CI builds the image for
> `linux/amd64` and `linux/arm64` but never pushes it to a registry.
>
> Unraid's **Docker tab** and **Community Applications** both install a
> container by pulling an image from a registry. Neither can install this
> application at all. There is no template to add and no repository string to
> paste.

The supported path is **Docker Compose against a clone of the repository on the
host**, built locally. That means:

- The **Compose Manager** plugin (from Community Applications), or
- `docker compose` over SSH.

Both are described below. If you are looking for a "Add Container" flow, there
isn't one, and adding one is a separate change — see
[Known gaps](#known-gaps-flagged-for-fixing).

---

## 1. Prepare a place for the clone

Build context matters here. **Do not put the clone on the flash drive.**
`/boot` is a USB stick with limited space and finite write endurance, and a
Docker build writes heavily.

Put it on the cache pool or the array:

```sh
mkdir -p /mnt/user/appdata/dissertation
cd /mnt/user/appdata/dissertation
git clone https://github.com/thegspiro/romania.git repo
cd repo
```

The clone stays. It is the build context, so updating means pulling into this
directory — see [`updating.md`](updating.md).

## 2. Configure

```sh
cp .env.example .env
```

Edit `.env` as [`installation.md`](installation.md#2-configure) describes.
Nothing in it is Unraid-specific.

## 3. Put the data on shares, not in Docker volumes

By default the compose file uses Docker named volumes, which live inside
`/var/lib/docker` — on Unraid that is the Docker vDisk image, which is not what
your array backs up and is not sized for a research corpus.

Point the data at real paths instead. **Do this in an override file, not by
editing `docker-compose.yml`**, so that `git pull` at update time does not
conflict with your local changes:

```sh
cat > docker-compose.override.yml <<'YAML'
services:
  web:
    volumes:
      - /mnt/user/appdata/dissertation/files:/data/files
      - /mnt/user/backups/dissertation:/data/backups
  worker:
    volumes:
      - /mnt/user/appdata/dissertation/files:/data/files
      - /mnt/user/backups/dissertation:/data/backups
  db:
    volumes:
      - /mnt/user/appdata/dissertation/mysql:/var/lib/mysql
YAML
```

Compose reads `docker-compose.override.yml` automatically alongside
`docker-compose.yml`, so nothing tracked has to change and the next `git pull`
has nothing to conflict with. The file is gitignored as local configuration.

A few notes on the paths themselves:

- **`files` and `mysql` belong on the cache pool.** `appdata` is normally a
  cache-only share. MySQL on a spun-up array disk is slow and keeps disks awake.
- **`backups` belongs somewhere the host itself backs up** — an array share
  covered by your backup plugin, or one that replicates off the machine. A
  backup stored inside the machine it protects is not a backup.
- **`web` and `worker` must share the same `/data/files` path.** Compilation
  hands work across that volume: the web app writes the assembled Markdown and
  the worker reads it back. Keep both mounts identical.

## 4. Fix the ownership before the first start

This is the step that catches people.

**The application containers run as uid 1000, gid 1000** — the `node` user from
the base image. **Unraid shares are owned by `nobody:users`, which is uid 99,
gid 100.** These do not match, and there is no `PUID`/`PGID` support to
reconcile them: the Dockerfile sets `USER node` and the uid is fixed at build
time.

An unwritable data directory is caught at startup by `scripts/check-storage.sh`
rather than surfacing as a 500 on the first upload, so the symptom is a
container that refuses to start with a message naming the path and the uid to
`chown` to. That is the intended behaviour — but it means an install that
skipped this step fails at step 5 rather than working.

Create the directories and hand them to uid 1000:

```sh
mkdir -p /mnt/user/appdata/dissertation/files \
         /mnt/user/backups/dissertation
chown -R 1000:1000 /mnt/user/appdata/dissertation/files \
                   /mnt/user/backups/dissertation
```

**Do not chown the MySQL directory to 1000.** The `db` service is the official
MySQL image and runs as its own `mysql` user, which is a different uid. Let the
container create and own that directory — make the parent only:

```sh
mkdir -p /mnt/user/appdata/dissertation/mysql
```

If you ever need that uid explicitly, read it from the image rather than
guessing:

```sh
docker compose run --rm --entrypoint sh db -c 'id mysql'
```

> **Unraid's "Docker Safe New Permissions" tool will undo this.** It resets
> ownership across shares to `nobody:users`. If you run it — or the New
> Permissions tool — re-apply the `chown -R 1000:1000` above afterwards, or the
> containers will stop starting with a `check-storage` failure.

## 5. Start it

Over SSH, from the clone:

```sh
cd /mnt/user/appdata/dissertation/repo
docker compose up -d --build
```

The first build takes several minutes and needs outbound network — it compiles
the TypeScript, installs the Python dependencies and downloads Pandoc and
Tectonic, each verified against a recorded SHA-256.

### Using Compose Manager instead

The Compose Manager plugin can drive the same composition from the Unraid
webGUI. Point the stack at the clone directory above rather than letting the
plugin keep the compose file in its own project directory — that default lives
under `/boot/config/plugins/compose.manager/projects/`, on the flash drive,
which is the wrong place for a build context for the reason given in step 1.

> Compose Manager's exact mechanism for using an external project directory
> varies between plugin versions, and this has not been verified against a live
> Unraid box — see [Known gaps](#known-gaps-flagged-for-fixing). The SSH path
> above is the one this documentation can vouch for. If you use Compose
> Manager, confirm the build context is the clone and not a copy on `/boot`.

## 6. Finish the install

The remaining steps are not Unraid-specific. From the clone directory:

```sh
docker compose run --rm web preflight
docker compose exec web /app/scripts/entrypoint.sh admin create-admin
```

Then follow [`installation.md`](installation.md#6-point-the-proxy-at-it) for
the reverse proxy and first sign-in. On Unraid the proxy is usually **SWAG** or
**Nginx Proxy Manager** from Community Applications; forward your domain to
`127.0.0.1:8080` and make sure `X-Forwarded-Proto` and `X-Forwarded-For` are
set.

Note that the web container binds to `127.0.0.1:8080` on the Unraid host, so it
is reachable from the host itself but not from the LAN. If your proxy runs in
its own container on a custom Docker network, it cannot reach `127.0.0.1` on
the host — either put the proxy on the same compose network, or change the
published binding in your override file and accept that the port is then
exposed on the LAN over plain HTTP.

---

## Backups

Enqueue a backup as [the README describes](../README.md#backups). The worker
writes a compressed dump and a file archive to `BACKUP_ROOT` and prunes to the
newest 14 of each.

Because `BACKUP_ROOT` is a share in the layout above, Unraid's own backup
tooling — the Appdata Backup plugin, a `rsync` User Script, or an unassigned
device — can take it off the machine from there. To run the backup nightly, add
a User Script on the schedule you want that issues the same statement.

---

## Updating

See [`updating.md`](updating.md). The short version on Unraid: back up first and
wait for it to finish, then `git pull && docker compose up -d --build` from the
clone. Your `docker-compose.override.yml` is untracked, so the pull will not
touch it.

---

## Known gaps, flagged for fixing

These are shortcomings in the application and its tooling, not in this page.
They are recorded here so an operator is not the one to discover them.

1. **No published image.** Until CI pushes to a registry, Unraid's normal
   install paths (Community Applications, the Docker tab) cannot be used, and
   every update is a local rebuild of a ~3 GB image. Publishing the existing
   multi-arch build to GHCR would make both work.
2. **No `PUID`/`PGID` support.** The uid is baked in at build time as 1000,
   which does not match Unraid's default share ownership of 99:100. Every
   Unraid install therefore needs a manual `chown`, and Docker Safe New
   Permissions silently undoes it. The usual fix is an entrypoint that adjusts
   the runtime uid, or documenting a `user:` override once it has been tested.
3. **Compose Manager integration is unverified.** The guidance above about
   project directories is reasoned from how the plugin stores projects, not
   tested on a live box. It should be confirmed and then stated plainly.
