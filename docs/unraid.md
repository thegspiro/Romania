# Installing on Unraid

Unraid is a first-class target for this application — the job queue is a MySQL
table rather than Redis specifically so there is one fewer service to run here.
But the install does not look like a normal Unraid install: there is no image to
pull and no template to add, and the container's user has to be told about
Unraid's before the first start.

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

## 4. Run the containers as Unraid's own user

This is the step that catches people, and it is worth understanding rather than
pasting.

Unraid owns its shares as `nobody:users` — **uid 99, gid 100**. The application
image is built from `node:22-bookworm-slim`, whose `node` user is **uid 1000**.
Those do not match.

Whether the mismatch actually breaks anything depends on the mode bits as much
as the ownership. A share left at Unraid's usual `0777` is writable by anyone,
uid 1000 included, and such an install works. But a directory you create over
SSH is `root:root 0755`, which uid 1000 cannot write to at all — and that is the
path these instructions take. Even where writing succeeds, everything the
container creates comes out owned by uid 1000, which is an unknown user to
Unraid: awkward over SMB, and awkward for any other container that needs to
read it.

So set the uid the image is built with:

```sh
# in .env, alongside the rest of the configuration
APP_UID=99
APP_GID=100
```

`docker-compose.yml` passes both to the build, so the containers run as
`nobody:users` and every file they write belongs to Unraid's own user. The
default stays 1000:1000, so nothing changes for a non-Unraid host.

This is a **build-time** setting — it is baked into the image, not read at
start — so it takes effect on the next `docker compose up -d --build`. The
container still never runs as root.

Then create the directories:

```sh
mkdir -p /mnt/user/appdata/dissertation/files \
         /mnt/user/backups/dissertation
chown -R 99:100 /mnt/user/appdata/dissertation/files \
                /mnt/user/backups/dissertation
```

The `chown` is still needed for directories you create yourself, because `mkdir`
as root makes them `root:root` whatever the container runs as.

**Do not chown the MySQL directory.** The `db` service is the official MySQL
image and runs as its own `mysql` user, which is neither 99 nor 1000 and is not
affected by `APP_UID`. Let the container create and own that directory — make
the parent only:

```sh
mkdir -p /mnt/user/appdata/dissertation/mysql
```

If you ever need that uid explicitly, read it from the image rather than
guessing:

```sh
docker compose run --rm --entrypoint sh db -c 'id mysql'
```

### If you skip this

An unwritable data directory is caught at startup by `scripts/check-storage.sh`,
which does a real write rather than testing a mode bit — so a read-only mount
and a full filesystem fail it too. The container refuses to start and the
message names the path and the uid to `chown` to, which is the uid the image was
actually built with. It is a loud failure at step 5 rather than a 500 on the
first upload months later.

### Changing it later

`APP_UID` decides who writes _new_ files; it does not move the ones already
there. If you change it on a running install, chown the existing data to match
in the same maintenance window:

```sh
docker compose down
chown -R 99:100 /mnt/user/appdata/dissertation/files \
                /mnt/user/backups/dissertation
docker compose up -d --build
```

> **Unraid's "Docker Safe New Permissions" tool resets share ownership** to
> `nobody:users`. With `APP_UID=99` and `APP_GID=100` that is now what the
> containers want, so the tool stops being something that breaks this install —
> which is most of the reason to set them rather than chowning to 1000.

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
2. ~~**No `PUID`/`PGID` support.**~~ Fixed: `APP_UID` and `APP_GID` are build
   arguments, defaulting to 1000:1000 and set to 99:100 on Unraid — see
   [step 4](#4-run-the-containers-as-unraids-own-user). Done at build time
   rather than as a runtime `PUID`/`PGID` because there is no published image
   to keep host-neutral, and the alternative is a root entrypoint that drops
   privileges — a worse trade for a rebuild that already happens on every
   install and update.
3. **Compose Manager integration is unverified.** The guidance above about
   project directories is reasoned from how the plugin stores projects, not
   tested on a live box. It should be confirmed and then stated plainly.
