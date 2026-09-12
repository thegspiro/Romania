# Installing on Unraid

Unraid is a first-class target for this application — the job queue is a MySQL
table rather than Redis specifically so there is one fewer service to run here.
But the install does not look like a normal Unraid install: it is a three-service
stack driven by Compose rather than a container you add from a template, and
the container's user has to be reconciled with Unraid's before the first start.

Read [`installation.md`](installation.md) for what the configuration values
mean. This page covers what is different on Unraid.

---

## What works, and what still does not

The image **is** published — `ghcr.io/thegspiro/romania`, for `linux/amd64`
and `linux/arm64` — so there is something to pull. That removes the hard
blocker, but it does not turn this into a template install:

- **Community Applications** lists applications from curated templates, not
  from registries. Publishing an image does not put an entry there; that needs
  a template submitted to the CA repository, which does not exist yet.
- **The Docker tab's "Add Container"** can pull the image, but this is three
  services — `web`, `worker` and a database — that share a volume and a
  network, and the web app hands compiled work to the worker across
  `/data/files`. Wiring that up by hand in three separate container forms is
  possible and is a bad idea; the compose files already express it.

So the supported path is still **Docker Compose against a clone of this
repository on the host**:

- The **Compose Manager** plugin (from Community Applications), or
- `docker compose` over SSH.

What has changed is that the clone is now only for the compose files and your
`.env` — `docker compose up -d` pulls the image rather than building it, so a
first install no longer waits several minutes on a local build. You still need
to build if you want the containers to run as uid 99; see
[step 4](#4-decide-which-uid-the-containers-run-as).

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

The repository ships an Unraid overlay for exactly this. Add it on the command
line rather than editing anything:

```sh
docker compose -f docker-compose.yml -f docker-compose.unraid.yml up -d --build
```

`docker-compose.unraid.yml` points `/data/files`, `/data/backups` and MySQL's
data directory at `/mnt/user` paths. Compose merges a service's volumes by
target path, so each entry replaces the named volume at that path rather than
adding a second mount beside it.

It is committed on purpose: running on Unraid is then a flag on the command
line rather than an edit to `docker-compose.yml`, which would conflict on every
`git pull` — and leave you resolving a merge in the file that defines your
deployment, at the worst possible moment.

Edit that file if your shares differ. Two things about the paths matter:

- **`files` and `mysql` belong on fast storage.** `appdata` is normally a
  cache-only share. MySQL on an array disk, behind the parity calculation, is
  noticeably slower than the same database on the cache pool.
- **`web` and `worker` must keep the same `/data/files`.** Compilation hands
  work across that volume: the web app writes the assembled Markdown and the
  worker reads it back. Change both or neither.

Since you will pass both files every time, it is worth making that the default
for the shell you deploy from:

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.unraid.yml
```

Every `docker compose` command in these pages then works as written. Without
it, remember the `-f` pair on **every** invocation — a `docker compose up -d`
that forgets them silently reverts to the named volumes, and the site comes
back up looking empty because it is pointed at a different, blank database.

## 4. Decide which uid the containers run as

This is the step that catches people, and it is worth understanding rather than
pasting.

Unraid owns its shares as `nobody:users` — **uid 99, gid 100**. The application
image is built from `node:22-bookworm-slim`, whose `node` user is **uid 1000**.
Those do not match, and the published image is built once, at 1000:1000.

Whether the mismatch breaks anything depends on the mode bits as much as the
ownership. A share left at Unraid's usual `0777` is writable by anyone, uid 1000
included. But a directory you create over SSH is `root:root 0755`, which uid
1000 cannot write to at all — and that is the path these instructions take.

There are two ways to settle it, and they lead to different install commands.

### Either: pull the published image, and give it the directories

Keep the image as published and hand it ownership of the three paths:

```sh
mkdir -p /mnt/user/appdata/dissertation/files \
         /mnt/user/backups/dissertation
chown -R 1000:1000 /mnt/user/appdata/dissertation/files \
                   /mnt/user/backups/dissertation
```

`docker compose up -d` then pulls and runs. The cost is that everything the
containers write is owned by uid 1000, which is an unknown user to Unraid —
awkward over SMB, and awkward for another container that needs to read it. And
**Unraid's "Docker Safe New Permissions" tool resets share ownership** to
`nobody:users`, which silently re-breaks this arrangement; you would re-apply
the `chown` after running it.

### Or: build the image as Unraid's own user

```sh
# in .env, alongside the rest of the configuration
APP_UID=99
APP_GID=100
```

```sh
mkdir -p /mnt/user/appdata/dissertation/files \
         /mnt/user/backups/dissertation
chown -R 99:100 /mnt/user/appdata/dissertation/files \
                /mnt/user/backups/dissertation
```

`docker-compose.yml` passes both to the build, so the containers run as
`nobody:users` and every file they write belongs to Unraid's own user. Docker
Safe New Permissions then sets shares to exactly what the containers want
rather than breaking them.

The cost is that this is a **build-time** setting — baked into the image, not
read at start — so it needs `docker compose up -d --build` on install and on
every update, and you wait for a local build each time. `APP_UID` cannot be
applied to an image you pulled.

Either way the container never runs as root.

> If you have no preference: pull, and chown to 1000. It is the shorter path
> and the one that stays current with no build. Build with `APP_UID=99` when
> other containers or SMB clients need to read these files, or when you would
> rather not remember the chown after each permissions reset.

### The MySQL directory is neither

**Do not chown it.** The `db` service is the official MySQL image and runs as
its own `mysql` user, which is neither 99 nor 1000 and is not affected by
`APP_UID`. Let the container create and own that directory — make the parent
only:

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

Whichever you pick, the uid decides who writes _new_ files; it does not move the
ones already there. If you switch, chown the existing data in the same
maintenance window:

```sh
docker compose down
chown -R 99:100 /mnt/user/appdata/dissertation/files \
                /mnt/user/backups/dissertation
docker compose up -d --build
```

## 5. Start it

Over SSH, from the clone. Which command depends on what you chose in step 4:

```sh
cd /mnt/user/appdata/dissertation/repo

docker compose up -d            # pulled the published image, chowned to 1000
docker compose up -d --build    # building as uid 99
```

Pulling fetches roughly a gigabyte and starts in under a minute. Building takes
several minutes and needs outbound network — it compiles the TypeScript,
installs the Python dependencies and downloads Pandoc and Tectonic, each
verified against a recorded SHA-256.

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

```sh
docker compose exec web /app/scripts/entrypoint.sh admin enqueue-backup
```

The worker writes a compressed dump and a file archive to `BACKUP_ROOT` and
prunes to the newest 14 of each.

Because `BACKUP_ROOT` is a share in the layout above, Unraid's own backup
tooling — the Appdata Backup plugin, an `rsync` User Script, or an unassigned
device — can take it off the machine from there. To run it nightly, put the
same command in a User Script on the schedule you want; see
[`updating.md`](updating.md#keeping-backups-running-between-updates) for the
exact line.

---

## Updating

See [`updating.md`](updating.md). The short version on Unraid: back up first and
wait for it to finish, then `git pull && docker compose up -d --build` from the
clone. `docker-compose.unraid.yml` is tracked, so a pull may update it —
harmless unless you edited your share paths into it, in which case git will
say so rather than overwrite them.

---

## Known gaps, flagged for fixing

These are shortcomings in the application and its tooling, not in this page.
They are recorded here so an operator is not the one to discover them.

1. ~~**No published image.**~~ Fixed: `ghcr.io/thegspiro/romania` is published
   for both architectures by the pipeline that runs the tests. What is still
   missing is a **Community Applications template**, which is what would make
   this appear in the place an Unraid user actually looks. That is a separate
   submission to the CA repository, not a change here.
2. **The container uid is fixed at build time, and now that matters more.**
   `APP_UID`/`APP_GID` are build arguments — see
   [step 4](#4-decide-which-uid-the-containers-run-as). That was a clean
   trade when every install built anyway. With an image published it is a real
   limitation: an Unraid operator who wants uid 99 gives up pulling and builds
   on every update, and the reasoning that justified build-time over runtime
   (`PUID`/`PGID` needs a root entrypoint that drops privileges, to save a
   rebuild that was happening regardless) no longer holds on its own terms.
   Worth revisiting as its own change set, weighing a root-then-drop entrypoint
   against the Dockerfile's standing rule that the container never runs as
   root.
3. **Compose Manager integration is unverified.** The guidance above about
   project directories is reasoned from how the plugin stores projects, not
   tested on a live box. It should be confirmed and then stated plainly.
