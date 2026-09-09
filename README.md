# Dissertation Research Platform

A self-hosted research and publication platform for a PhD dissertation.

It holds the material a dissertation is built from — bibliographic sources,
archival artifacts, essays, and the people, places, organizations and events
they concern — and lets each item be **public or private individually**.
Everything is cross-referenced, and every source carries a citation formatted
to the **Chicago Manual of Style** (notes and bibliography).

Designed for one researcher, on their own hardware, with the public side
exposed to the internet.

---

## Status

This is the **foundation** release. What is built and working:

| Area                                                                     | State                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Schema for all entity types                                              | Complete (sources, artifacts, essays, people, organizations, places, events, relationships, citations, tags, files) |
| **Sources** — admin CRUD, publish/unpublish, public pages                | Complete                                                                                                            |
| Chicago citation rendering                                               | Complete (CMOS 18th ed., notes and bibliography)                                                                    |
| Authentication — password + passkey, recovery codes                      | Complete                                                                                                            |
| Public/private enforcement                                               | Complete and tested                                                                                                 |
| Background worker — derivatives, bibliography import, geocoding, backups | Complete                                                                                                            |
| Deployment — Docker, Compose, migrations, CLI                            | Complete                                                                                                            |
| Admin UI for artifacts, essays, people, places, events                   | **Not yet** (schema exists)                                                                                         |
| File upload UI                                                           | **Not yet** (storage layer and worker exist)                                                                        |
| Maps and relational network graphs                                       | **Not yet** (Leaflet and Cytoscape are vendored; coordinates and edges are in the schema)                           |
| Pandoc export to PDF/DOCX/LaTeX                                          | **Not yet** (toolchain is in the image)                                                                             |

Each of those is a separate change set on top of this one. The architecture
below is what makes them additive rather than rewrites.

---

## Architecture

One Docker image, three roles:

```
  ┌──────────┐        ┌──────────┐
  │   web    │        │  worker  │        Node 22 + TypeScript (web)
  │ Fastify  │        │ Python   │        Python 3.11 (worker)
  └────┬─────┘        └────┬─────┘        Same image, different entrypoint
       │                   │
       └────────┬──────────┘
                │
          ┌─────▼─────┐
          │  MySQL 8  │  utf8mb4_0900_ai_ci
          └───────────┘
```

- **web** — Fastify serving server-rendered HTML (Nunjucks). No client-side
  framework; the only JavaScript is the passkey ceremony and, later, the map
  and graph widgets.
- **worker** — polls a job table in MySQL. There is no Redis: one fewer
  service to run, and a job commits in the same transaction as the data that
  caused it.
- **db** — MySQL 8. Portable to AWS RDS unchanged.

### The content model

Everything publishable is a row in `content_item`, which owns the fields that
must behave identically for all of them — slug, title, language, visibility,
indexing policy. Kind-specific fields live in a detail table keyed 1:1 on it.

```
content_item (kind, slug, title, visibility, …)
  ├── source_detail    (csl_json, archive, call_number, …)
  ├── artifact_detail  (file, provenance, repository, …)
  ├── essay_detail     (body_markdown, status, …)
  ├── agent_detail     (people and organizations)
  ├── place_detail     (latitude, longitude, historical names)
  └── event_detail     (dates, place)
```

Cross-referencing, the public/private rule, tagging, search and the
relationship graph are therefore implemented **once**. Adding an entity type
is a new detail table plus templates — never a rewrite of those mechanisms.

### Citations

Sources are stored as **CSL-JSON**, the interchange format Zotero, Pandoc and
citeproc all speak. Chicago output is produced by citeproc against a vendored
CSL style; this project writes no citation formatting of its own, because
Chicago's edge cases are where citation bugs live.

The same data is what Pandoc needs to produce PDF, DOCX, HTML or LaTeX later,
with no conversion step in between.

---

## Security

The public side is on the internet, so these are properties of the whole
application, not of the admin area:

**Authentication.** Argon2id password (parameters configurable, upgraded on
login when policy is raised), then a **WebAuthn passkey** as a mandatory
second factor. A session that has passed only the password can read nothing
private. The session id is rotated when the second factor succeeds.

**Passkeys work with any authenticator** — Bitwarden, 1Password, iCloud
Keychain, Google Password Manager, or a hardware key. This is deliberate:
`authenticatorAttachment` is left unset and attestation is not requested,
which is what keeps cross-platform credential managers visible in the
browser's prompt.

> If your password lives in the same vault as your passkey, the two are not
> independent factors — compromise of the vault gets both. Register at least
> one passkey outside that vault (your phone, or a hardware key).

**Recovery.** Ten single-use recovery codes, 100 bits of entropy each, shown
once. Plus a CLI inside the container that can reset the password and list or
revoke passkeys — a path that requires shell access, which the network cannot
provide.

**The public/private rule.** One chokepoint (`src/content/visibility.ts`)
decides what a viewer may see, and three invariants are enforced and tested:

1. A private item returns **404, not 403**, to an anonymous visitor. A 403
   would confirm that something exists at that slug — for unpublished research
   about named people, that confirmation is itself the disclosure.
2. A public page referencing a private item shows it as plain text, never a
   link, and never leaks its title or slug.
3. File bytes are served only through a route that re-checks the owning item's
   visibility on every request.

**Everything else.** Strict CSP with per-response nonces and no
`unsafe-inline`; CSRF tokens on every state-changing request; HttpOnly,
Secure, SameSite=Lax cookies with the `__Host-` prefix; login rate limiting
and lockout; all SQL through bound parameters; uploads typed by magic bytes
and stripped of EXIF; an audit trail that outlives the rows it describes.

**Search engines are blocked by default.** `robots.txt` disallows everything
and every response carries `X-Robots-Tag: noindex`. Research that has been
crawled, cached and archived cannot be un-crawled, so the default is the
recoverable one. Set `ALLOW_SEARCH_INDEXING=true` when you are ready.

---

## Installation

### Requirements

- Docker with Compose v2
- A reverse proxy terminating TLS (SWAG, Nginx Proxy Manager, Traefik,
  Caddy or a Cloudflare Tunnel)
- A domain name

**HTTPS is not optional.** WebAuthn refuses to run outside a secure context,
so passkeys will not work over plain HTTP on any host but `localhost`.

### 1. Configure

```sh
git clone https://github.com/thegspiro/romania.git
cd romania
cp .env.example .env
```

Edit `.env`. At minimum:

```sh
PUBLIC_BASE_URL=https://dissertation.example.org
WEBAUTHN_RP_ID=dissertation.example.org      # bare domain: no scheme, no port
WEBAUTHN_ORIGIN=https://dissertation.example.org
TRUST_PROXY=true                             # you are behind a reverse proxy
DB_PASSWORD=$(openssl rand -base64 24)
DB_ROOT_PASSWORD=$(openssl rand -base64 24)
```

> **`WEBAUTHN_RP_ID` is effectively permanent.** Passkeys are bound to that
> domain. Changing it after registration invalidates every passkey, and you
> would need your password plus a recovery code to get back in. Decide on the
> final hostname before you register anything.

The application refuses to start on an invalid configuration rather than
running with an unsafe default, so a mistake here is loud, not silent.

### 2. Start

```sh
docker compose up -d --build
```

Migrations run automatically on start. Then create your account:

```sh
docker compose exec web /app/scripts/entrypoint.sh admin create-admin
```

It prompts for a username and password and prints ten recovery codes. **Save
them now — they are shown once.**

### 3. Point the proxy at it

The web container publishes on `127.0.0.1:8080`, so it is not reachable from
the network except through your proxy. Forward your domain to that port and
make sure the proxy sets `X-Forwarded-Proto` and `X-Forwarded-For`.

### 4. First sign-in

Visit `https://your-domain/login`, sign in with your password, and register a
passkey when prompted — Bitwarden will offer to store it. Then register a
second one on a different device from `/admin/security`.

---

### On Unraid

Use the Compose Manager plugin, or run the commands above over SSH. Replace
the named volumes with array paths so backups and files live on the array
rather than inside Docker:

```yaml
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
```

The containers run as uid 1000, which matches the default ownership of Unraid
shares. If yours differ, `chown -R 1000:1000` those paths.

### On AWS or another cloud host

Point `DB_HOST` at RDS for MySQL 8 and delete the `db` service from
`docker-compose.yml`. Nothing else changes: the schema uses no MySQL features
RDS lacks. Storage stays on a mounted volume (EBS or EFS); an S3 backend is a
contained change behind the storage interface, not yet built.

---

## Operating it

All commands run inside the container:

```sh
docker compose exec web /app/scripts/entrypoint.sh <command>
```

| Command                                    | Does                                       |
| ------------------------------------------ | ------------------------------------------ |
| `admin create-admin`                       | Create the administrator account           |
| `admin reset-password --username u`        | Set a new password and revoke all sessions |
| `admin list-passkeys --username u`         | List registered passkeys                   |
| `admin revoke-passkey --username u --id 3` | Remove one passkey                         |
| `admin recovery-codes --username u`        | Generate a fresh set of codes              |
| `admin sessions-revoke --username u`       | Sign out everywhere                        |
| `migrate status`                           | Show which migrations are applied          |
| `migrate up`                               | Apply pending migrations                   |
| `migrate down --to 2`                      | Roll back to version 2                     |

### Backups

Enqueue a backup job:

```sh
docker compose exec db mysql -u root -p"$DB_ROOT_PASSWORD" dissertation \
  -e "INSERT INTO job (kind, payload) VALUES ('backup.run', '{\"keep\": 14}')"
```

The worker writes a compressed dump and a file archive to `BACKUP_ROOT` and
prunes to the newest 14 of each. Point that at a share the host itself backs
up — a backup inside the container it protects is not a backup. To run it
nightly, add a cron entry on the host that issues the same statement.

### Locked out?

1. **Lost your passkey** → sign in with your password and a recovery code, then
   register a new passkey and regenerate the codes.
2. **Lost the codes too** → `admin reset-password` from a shell on the host,
   then `admin revoke-passkey` for the ones you no longer have.
3. **Lost the domain** → `WEBAUTHN_RP_ID` has changed, so every passkey is
   invalid. Password plus recovery code still work; register new passkeys after.

---

## Development

Requires Node 22+, Python 3.11+ and a MySQL 8 server.

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

cp .env.example .env      # WEBAUTHN_RP_ID=localhost for local work
npm run build
npm run migrate
npm run admin -- create-admin
npm run dev               # http://localhost:8080
```

Browsers treat `http://localhost` as a secure context, so passkeys work
locally without TLS — but only for the exact host `localhost`, not
`127.0.0.1` and not a LAN address.

### Checks

```sh
npm run typecheck                    # tsc --noEmit
npm run lint                         # eslint
npm run format:check                 # prettier
npm test                             # vitest: unit + integration
.venv/bin/ruff check worker/         # python lint
.venv/bin/pytest                     # python tests
```

Integration tests need a MySQL server and **drop every table in the target
database**. Point them at a disposable one:

```sh
TEST_DB_HOST=127.0.0.1 TEST_DB_NAME=dissertation_test \
TEST_DB_USER=dissertation TEST_DB_PASSWORD=… npm test
```

With no database reachable they skip rather than fail, so the unit suites
still run.

### Layout

```
src/
  config.ts          Environment parsing and validation
  db/                Connection pool, migration runner
  auth/              Password, WebAuthn, sessions, CSRF, recovery codes
  content/           Repositories, the visibility chokepoint, slugs, audit
  citations/         CSL-JSON model, citeproc rendering, vendored CSL style
  http/              Server assembly, security headers, error handling
  routes/            auth, admin, public
  views/             Nunjucks templates
  cli/               Administrative command line
worker/              Python job runner and handlers
db/migrations/       Numbered SQL, each with a tested rollback
tests/               Vitest unit and integration suites
```

`CLAUDE.md` and `AGENTS.md` document the conventions and invariants for
anyone — human or agent — changing this code.

---

## License

GPL-3.0-or-later. See `LICENSE`.

The vendored Citation Style Language files under `src/citations/styles/` are
CC BY-SA 3.0 and belong to the CSL project; see the `NOTICE.md` beside them.
