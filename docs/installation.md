# Installation

This page installs the platform on a Docker host. If you are installing on
Unraid, read [`unraid.md`](unraid.md) instead — it covers the same steps with
the paths and file ownership Unraid actually uses. When the install is done,
[`updating.md`](updating.md) covers keeping it current.

---

## Before you start

You need:

- **Docker with Compose v2** (`docker compose version` should print v2.x).
- **A reverse proxy terminating TLS** — SWAG, Nginx Proxy Manager, Traefik,
  Caddy or a Cloudflare Tunnel.
- **A domain name** pointed at that proxy.
- **Roughly 3 GB of disk for the image**, plus whatever the research itself
  needs. The image carries Pandoc and Tectonic so a manuscript can be compiled
  without a second service.

**HTTPS is not optional.** WebAuthn refuses to run outside a secure context,
so passkeys will not work over plain HTTP on any host except `localhost`.
Install the proxy first if you do not have one.

> **The image is published**, at `ghcr.io/thegspiro/romania`, for
> `linux/amd64` and `linux/arm64`. The pipeline that runs the tests is the one
> that pushes it, and only from `main` — so what you pull is what CI passed.
>
> You still clone, because the compose files and `.env.example` live in this
> repository and a deployment needs them. What you no longer wait for is a
> local build.

---

## 1. Get the code

```sh
git clone https://github.com/thegspiro/romania.git
cd romania
```

Keep this clone. It holds `docker-compose.yml`, the Unraid overlay and your
`.env`, and an update pulls into it — see [`updating.md`](updating.md). It is
also the build context if you choose to build rather than pull.

## 2. Configure

```sh
cp .env.example .env
```

Every value in `.env.example` is documented in place. At minimum, edit these:

```sh
PUBLIC_BASE_URL=https://dissertation.example.org
WEBAUTHN_RP_ID=dissertation.example.org      # bare domain: no scheme, no port
WEBAUTHN_ORIGIN=https://dissertation.example.org
TRUST_PROXY=true                             # you are behind a reverse proxy
DB_PASSWORD=…                                # openssl rand -base64 24
DB_ROOT_PASSWORD=…                           # openssl rand -base64 24
```

Generate the two passwords rather than inventing them:

```sh
openssl rand -base64 24
```

Both must be real values. The application refuses to start in production while
`DB_PASSWORD` is still the `change-me` placeholder, because that string is
published in this repository.

`TRUST_PROXY=true` makes the application read the client IP and scheme from
`X-Forwarded-*`. Set it only when a proxy really is in front: without one, a
client can spoof its own IP and defeat login throttling.

> **`WEBAUTHN_RP_ID` is effectively permanent.** Passkeys are bound to that
> domain. Changing it after registration invalidates every passkey, and you
> would need your password plus a recovery code to get back in. Decide on the
> final hostname before you register anything.

The application validates the whole configuration at startup and refuses to
start on an invalid one rather than running with an unsafe default, so a
mistake here is loud rather than silent.

### Keeping secrets out of `.env`

Every secret also has a `*_FILE` form, read from a file instead of the
environment — the convention Docker Swarm, Kubernetes and Unraid secret mounts
use:

```sh
DB_PASSWORD_FILE=/run/secrets/db_password
ZOTERO_API_KEY_FILE=/run/secrets/zotero_api_key
```

Set exactly one of `DB_PASSWORD` or `DB_PASSWORD_FILE`; setting both is a
configuration error and the application says so.

One caveat: the bundled `db` service still needs a literal `DB_PASSWORD` in
`.env` to create the account on its first run. The `_FILE` form covers the web
service, the worker and `wait-for-db.sh`, so it fits a database you manage
yourself rather than the bundled one.

## 3. Start it

```sh
docker compose up -d
```

That pulls `ghcr.io/thegspiro/romania:latest` and starts three containers:
`web`, `worker` and `db`. Database migrations are applied automatically by the
`web` role on start.

### Building instead of pulling

```sh
docker compose up -d --build
```

Build when you have local changes, or when you need the container to run as a
uid other than 1000 — the published image is built once, at `1000:1000`, and
`APP_UID` is a build argument, so it cannot be applied to an image you pulled.
That is the Unraid case; [`unraid.md`](unraid.md) covers both ways round.

The first build takes several minutes — it compiles the TypeScript, installs
the Python dependencies and downloads Pandoc and Tectonic, each verified
against a recorded SHA-256. Subsequent builds reuse the cached layers.

### Pinning a version

`latest` moves with every merge to `main`. To hold a deployment still, set an
immutable tag in `.env`:

```sh
IMAGE_TAG=sha-1a2b3c4d5e6f
```

Every published commit carries a `sha-<commit>` tag; the available tags are
listed on the package page at `ghcr.io/thegspiro/romania`.

Watch it settle:

```sh
docker compose logs -f web
```

The first run waits for MySQL to finish initialising, which takes tens of
seconds, then applies every migration and starts the service.

## 4. Check the install

```sh
docker compose run --rm web preflight
```

It reports the configuration it loaded, the database connection, pending
migrations, whether the storage backend is reachable, whether the data
directories are writable and whether an administrator exists — then exits
non-zero if anything is actually broken.

```
[ ok ] configuration    valid, NODE_ENV=production
[ ok ] public url       https://dissertation.example.org
[ ok ] passkeys         relying party "dissertation.example.org", origins: https://dissertation.example.org
[ ok ] indexing         disabled, so nothing public is crawled
[ ok ] database         connected to dissertation at db:3306
[ ok ] migrations       all 15 applied
[warn] administrator    none yet -- run: docker compose exec web /app/scripts/entrypoint.sh admin create-admin
[ ok ] storage          local directory /data/files is reachable
[ ok ] scratch          /data/files is writable
[ ok ] backups          /data/backups is writable

preflight: ready, with 1 thing(s) to look at above.
```

`storage` and `scratch` are two different questions, which is why both are
asked. `storage` is the configured backend — under `s3` that line reads
`s3 bucket my-dissertation-files is reachable` and the check behind it is a
HeadBucket, so a wrong region or a role without access fails here rather than
on the first upload. `scratch` is `STORAGE_ROOT`, which stays required under
either backend because an upload is hashed into a local file before it can be
addressed by content.

A failed database connection reports `migrations` and `administrator` as
`skip` rather than `FAIL`, so the report has exactly as many failures as there
are things to fix.

**Read the public URL and the relying party back.** A value can be valid and
still not be the one you meant, and the passkey line is the one that is
expensive to get wrong.

`run --rm` is used rather than `exec` on purpose: preflight is most useful when
the web container is _not_ healthy, and `exec` cannot reach a container that is
crash-looping. Both forms work when the service is up:

```sh
docker compose exec web /app/scripts/entrypoint.sh preflight
```

## 5. Create your account

```sh
docker compose exec web /app/scripts/entrypoint.sh admin create-admin
```

It prompts for a username and a password, then prints ten recovery codes.

> **Save the recovery codes now — they are shown once.** They are stored as
> Argon2id hashes, so nobody can recover them for you. With the password and
> one code you can get back in after losing every passkey; without them, you
> cannot.

## 6. Point the proxy at it

The web container publishes on `127.0.0.1:8080`, so it is not reachable from
the network except through your proxy. That binding is deliberate: published on
`0.0.0.0` the application would be reachable over plain HTTP, where the session
cookie is readable in transit.

Forward your domain to `127.0.0.1:8080` and make sure the proxy sets:

- `X-Forwarded-Proto` — otherwise the application believes it is on HTTP and
  the `__Host-` session cookie will not be issued.
- `X-Forwarded-For` — otherwise login throttling sees every attempt as coming
  from the proxy.

Nginx Proxy Manager and SWAG set both by default. With Traefik and Caddy they
are also the default, but confirm rather than assume.

## 7. First sign-in

Visit `https://your-domain/login` and sign in with the username and password
from step 5. Register a passkey when prompted — Bitwarden and other credential
managers will offer to store it.

Then register a **second passkey on a different device** from
`/admin/security`. One passkey plus one device is a single point of failure.

## Verify before you consider it installed

- [ ] `docker compose ps` shows `web`, `worker` and `db` all healthy.
- [ ] `docker compose run --rm web preflight` exits 0 with no `FAIL` lines.
- [ ] `https://your-domain/` loads over HTTPS.
- [ ] You can sign in, and a passkey works on a second device.
- [ ] `curl -s https://your-domain/robots.txt` disallows everything — search
      engines are blocked until you set `ALLOW_SEARCH_INDEXING=true`.
- [ ] The recovery codes are somewhere that is not this server.

---

## Where the data lives

| Volume           | Mounted at          | Holds                                      |
| ---------------- | ------------------- | ------------------------------------------ |
| `database`       | `/var/lib/mysql`    | The MySQL data directory                   |
| `files`          | `/data/files`       | Uploads and derivatives, addressed by hash |
| `backups`        | `/data/backups`     | Database dumps and file archives           |
| `tectonic-cache` | `/home/node/.cache` | TeX packages Tectonic fetched for a PDF    |

The first three are yours and want backing up. `tectonic-cache` is a cache and
does not: it exists because the containers run on a read-only root filesystem,
and because a `tmpfs` would make every restart re-download the same TeX — which
on a host with no outbound network means the next PDF simply fails.

By default these are Docker named volumes. On a host that backs up specific
paths — which is the usual arrangement on Unraid and on a cloud host with
snapshots — replace them with bind mounts to paths the host actually protects.
See [`unraid.md`](unraid.md) for how to do that without the edit being undone
by the next `git pull`.

**A bind mount carries the host's ownership**, and the container has to be able
to write to it. The containers run as uid 1000 by default — the base image's
`node` user. Where the host uses something else, set it at build time rather
than chowning around it:

```sh
APP_UID=99      # in .env; 99:100 is nobody:users, which is what Unraid uses
APP_GID=100
```

Both default to 1000, so leaving them unset builds exactly what it always did.
They are baked into the image, so a change takes effect on the next
`docker compose up -d --build` — and the container still never runs as root.

**`web` and `worker` must share `/data/files`.** Compilation hands work across
that volume: the web app writes the assembled Markdown there and the worker
reads it back. The compose file already mounts the same volume into both; keep
that true if you ever split the roles across hosts.

---

## Running the database elsewhere

Set `DB_HOST` in `.env` to your RDS, Cloud SQL or other managed endpoint. The
compose file reads that value rather than pinning the bundled service name, so
nothing else in it needs editing for the application to connect.

Then remove the bundled database, which is two edits in `docker-compose.yml`:

1. Delete the `db` service.
2. Delete the `depends_on: db` block from **both** `web` and `worker`. Compose
   refuses to start a composition that depends on a service which no longer
   exists, so leaving these behind fails immediately.

`DB_ROOT_PASSWORD` becomes unused — it only ever fed the bundled container.

The schema uses no MySQL features RDS lacks. Storage can stay on a mounted
volume (EBS or EFS), or move to S3:

```sh
STORAGE_BACKEND=s3
S3_BUCKET=my-dissertation-files
S3_REGION=eu-west-2
```

Set it on **both** the web and worker services — the worker writes the
derivatives the web service serves. Leave `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` unset to use an instance or container role, which is the
better arrangement: no long-lived key for this application to hold. Set both or
neither; half a pair is refused at startup. `STORAGE_ROOT` stays required — an
upload is hashed into a local scratch file before it can be addressed by
content, and the worker needs somewhere to put a file Pandoc can read.

For anything that is not AWS — MinIO, Backblaze B2, Wasabi, Ceph — also set
`S3_ENDPOINT`, and `S3_FORCE_PATH_STYLE=true` follows from it automatically.

**Moving an existing corpus.** Changing the backend changes where bytes are
looked for, not where they are, so migrate before you rely on it:

```sh
docker compose exec web node dist/cli/admin.js storage migrate --dry-run
docker compose exec web node dist/cli/admin.js storage migrate --verify
```

It is driven by the database rather than a directory walk, is re-runnable, and
**copies rather than moves** — the local files stay intact, so switching back
is possible. Leave them in place until the new backend has been seen to work.

> **Backups change shape under S3.** The backup job's file archive tars a
> directory, and there is no directory to tar. It logs, loudly, that files were
> not archived and backs up the database only. Protect the bucket with
> versioning and a lifecycle rule, or replication to a second bucket — that is
> yours to arrange, and a backup that quietly holds less than you believe is
> discovered during a restore.

> Editing `docker-compose.yml` in the clone means `git pull` will conflict on
> it at every update. Put these changes in a `docker-compose.override.yml`
> instead where you can — though note that removing a service is one of the
> few things an override file cannot express, so the `db` deletion does have to
> be made in the tracked file. [`updating.md`](updating.md) covers handling
> that at update time.

---

## When something is wrong

| What you see                                         | What it means                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait-for-db: gave up after 120s … Access denied`    | `DB_PASSWORD` does not match what the database was created with. See below.                                                                                |
| `wait-for-db: gave up after 120s … Unknown database` | `DB_NAME` does not exist on the host `DB_HOST` points at.                                                                                                  |
| `check-storage: … is not writable`                   | A bind-mounted path is owned by the wrong uid. The message names the uid the image was built with — `chown` to it, or set `APP_UID`/`APP_GID` and rebuild. |
| `DB_PASSWORD must be set in .env`                    | Compose could not interpolate it — the variable is missing from `.env` entirely.                                                                           |
| The app starts but passkeys fail in the browser      | The page is not on HTTPS, or `WEBAUTHN_RP_ID` does not match the domain in the address bar.                                                                |
| Signing in loops back to the login page              | The proxy is not sending `X-Forwarded-Proto`, so the secure cookie is never issued.                                                                        |
| A PDF build fails on a TeX package                   | Tectonic fetches packages on demand and the container has no outbound network.                                                                             |

**Changing `DB_PASSWORD` after the first start does not change the database.**
The bundled MySQL container reads `MYSQL_PASSWORD` only when it initialises an
empty data directory. Once the `database` volume exists, editing `.env` changes
what the application sends and not what MySQL expects, which presents as
`Access denied` from `wait-for-db.sh`. Either set the password back, or change
it inside MySQL:

```sh
docker compose exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root \
     -e "ALTER USER \"$MYSQL_USER\"@\"%\" IDENTIFIED BY \"the-new-password\";"'
```

Both variables expand inside the container, where Compose set them. Writing
`-p"$DB_ROOT_PASSWORD"` would expand it in your own shell instead, where `.env`
is not exported and the variable is empty — which leaves a bare `-p` and an
interactive prompt that fails outright under `exec -T`. `MYSQL_PWD` also keeps
the password out of the container's process list.

---

## Next

- [`updating.md`](updating.md) — updating, rolling back, restoring a backup.
- [`unraid.md`](unraid.md) — Unraid paths, ownership and Compose Manager.
- The **Operating it** section of [`../README.md`](../README.md) — the admin
  CLI, compiling a manuscript, exporting the corpus, backups and the restore
  rehearsal.
