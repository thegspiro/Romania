# Dissertation Research Platform

A self-hosted research and publication platform for a PhD dissertation.

It holds the material a dissertation is built from — bibliographic sources,
archival artifacts, essays, and the people, places, organizations and events
they concern — and lets each item be **public or private individually**.
Everything is cross-referenced, and every source carries a citation formatted
to the **Chicago Manual of Style** (notes and bibliography).

The site shows the work as **pieces of a whole**: each essay is its own page,
and behind them is an outline that knows how to recompile those pieces into a
single document — PDF, DOCX, HTML or LaTeX — with the footnotes and
bibliography rendered by the same Chicago style the web pages use.

Designed for one researcher, on their own hardware, with the public side
exposed to the internet.

---

## Status

What is built and working:

| Area                                                                      | State                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Schema for all entity types                                               | Complete (sources, artifacts, essays, people, organizations, places, events, relationships, citations, tags, files) |
| **Sources** — admin CRUD, publish/unpublish, public pages                 | Complete                                                                                                            |
| **Essays** — Markdown editor, reference picker, server-rendered preview   | Complete                                                                                                            |
| **Revision history** — every save recorded, compared and restorable       | Complete (append-only; restoring writes a new revision)                                                             |
| **People, organizations, places, events** — admin CRUD and public pages   | Complete                                                                                                            |
| **Artifacts** — catalogue records, file upload, access-controlled serving | Complete                                                                                                            |
| **Inline references and backlinks** — "everywhere this person is named"   | Complete (a backlink lands on the paragraph that named the subject)                                                 |
| **Timeline** — chronology page, per-subject chronologies, blocks in prose | Complete (optional times; a contested event placed by "after X, before Y")                                          |
| **Manuscripts** — nested outline, prev/next navigation, reusable sections | Complete                                                                                                            |
| **Compilation** — Pandoc to PDF, DOCX, HTML, LaTeX, per audience          | Complete                                                                                                            |
| **Relationship graph** — typed edges plus mentions, Cytoscape             | Complete                                                                                                            |
| **Roles and positions** — offices and periods on an edge, network by year | Complete                                                                                                            |
| Chicago citation rendering                                                | Complete (CMOS 18th ed., notes and bibliography)                                                                    |
| Authentication — password + passkey, recovery codes                       | Complete                                                                                                            |
| Public/private enforcement                                                | Complete and tested                                                                                                 |
| Background worker — derivatives, bibliography import, geocoding, backups  | Complete                                                                                                            |
| **Zotero sync** — pull a library in and keep it in step                   | Complete (incremental; deletions are flagged, never obeyed)                                                         |
| Deployment — Docker, Compose, migrations, CLI                             | Complete                                                                                                            |
| Maps                                                                      | **Not yet** (Leaflet is vendored; coordinates are in the schema)                                                    |
| Public downloads of compiled documents                                    | **Not yet** (deliberately admin-only for now — see below)                                                           |
| Search beyond `LIKE`                                                      | **Not yet** (a search service is the first side-cart candidate)                                                     |

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
  framework; the only JavaScript is the passkey ceremony, the essay editor's
  reference picker, and the network graph. All three are vanilla, vendored
  locally, and loaded with a CSP nonce.
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
  ├── source_detail      (csl_json, archive, call_number, …)
  ├── artifact_detail    (file, provenance, repository, …)
  ├── essay_detail       (body_markdown, status, …)
  ├── agent_detail       (people and organizations)
  ├── place_detail       (latitude, longitude, historical names)
  ├── event_detail       (dates, place)
  └── manuscript_detail  (title page, abstract, numbering)
```

Cross-referencing, the public/private rule, tagging, search and the
relationship graph are therefore implemented **once**. Adding an entity type
is a new detail table plus templates — never a rewrite of those mechanisms.

### References, and what they make possible

While writing, a sidebar picker inserts a reference at the cursor. The text it
writes is readable and stays meaningful in any other Markdown editor:

```
[[person:ion-antonescu|Antonescu]]     a mention  → link on the web, plain text in print
[[place:iasi]]                         a mention  → display defaults to the target's title
[[cite:hooligan-year|45-47]]           a citation → footnote on the web and in print
```

A chronology can be embedded the same way, as a fenced block. It is resolved
for the reader asking, so it can never list an event they could not already
open a page at a time:

````
```timeline
about: person:ion-antonescu, place:iasi
from: 1940
to: 1944
```
````

References are keyed to the **slug**, not to a database id, so they survive a
title being corrected and remain readable outside the application.

Every save rebuilds the `mention` and `citation` rows from the prose, in the
same transaction as the text itself. Nothing else writes them. That is what
makes **"everywhere this person is mentioned"** trustworthy: the listing is
derived from the writing and cannot drift from it, and a reference removed
from an essay disappears from the subject's page immediately.

Each person, organization, place and event page therefore shows its own
fields, everywhere it is mentioned (with the surrounding sentence as context),
its typed relationships, and a network graph of connections within two hops.

### Revision history

Prose is the only thing in this application that exists nowhere else. A source
can be re-imported from Zotero and an artifact re-read from its file; a
paragraph overwritten by accident is simply gone. So every save that changes an
essay's title, body or status appends a snapshot, in the **same transaction** as
the change — a history written separately could record text that was never
committed.

The history is on the editor, under **History**. Each revision compares against
the one before it, line by line, with unchanged runs collapsed and the number of
skipped lines shown rather than quietly closed up.

A revision records the state **after** a save, so the newest revision is always
the current text. That is what makes "restore revision 7" mean exactly what it
looks like.

**Restoring writes a new revision** rather than rewinding to an old one, so the
mistake and its correction both survive, and nothing in the history is ever
edited or deleted. Because a restore is an ordinary save, `rebuildReferences`
runs over the restored prose like any other — the mention and citation listings
follow the text back.

> **Visibility is not restored.** Whether a piece of research is published is a
> decision about now, never a property of old text. Restoring prose written
> while an essay was public leaves the essay exactly as private as it is.

Saving an unchanged form records nothing, so the list holds real edits rather
than every time the button was pressed.

### Roles, positions and periods

A relationship may say more than that two people were connected. It can carry
the **office it was held in** and the **period it held for**:

```
Ion Antonescu  --[ Held office in ]-->  Council of Ministers
                 President of the Council of Ministers, 1940-1944
```

Both live on the edge rather than on either endpoint, because an office is a
property of the connection: the same person may hold several posts at one
institution in succession, and the same post passes between people. Each is
its own edge, so a career reads as a sequence rather than as one flattened
line, and the drawing labels each edge with the role rather than the bare
predicate.

Dates carry a **precision**, the same contract `event_detail` uses: a date
stored as `1944-01-01` with year precision reads as "1944", never as
"1 January 1944". Nothing renders more exactness than was claimed.

Because the edges are dated, the network can be asked what it looked like at a
moment. `?year=1941` on an entity page draws only the relationships whose
period covers that year. A relationship with **no dates recorded is always
drawn** — an unknown period is not an absent one, and hiding undated edges
would quietly empty a half-recorded corpus. The year narrows the walk on top
of the visibility rule and never in place of it: no year makes a private node
reachable.

### From pieces to a single document

A manuscript is an ordered outline of existing essays with a depth column —
a document outline, not a tree of new content. One essay may appear in several
manuscripts, which is what makes a chapter reusable as a journal article, but
at most once within any one of them.

Compilation splits along the same seam as everything else:

```
web (TypeScript)                            worker (Python)
  walk the outline, viewer-filtered
  demote headings by depth
  [[cite:x|45]]  → [@x, 45]
  [[person:x|N]] → N, or a cross-reference
  write document.md + references.json  ──►  pandoc --citeproc --csl=…
  insert manuscript_build (pending)         --pdf-engine=tectonic
  enqueue the job                           store the output, mark it succeeded
```

The worker makes **no visibility decisions** and does no reference parsing.
The rule stays in the one place that is auditable, and there is no second
cross-language copy of the parser to fall out of step.

A compiled file is one object containing many sections, so it is the single
place where one mistake would leak everything at once. `manuscript_build`
records the `audience` it was assembled for — `admin` or `public` — and a
public build is assembled with an **anonymous viewer**, so it can only contain
what an anonymous reader could already read one page at a time. Downloads
require an authenticated administrator; the column is what makes opening them
up later a configuration change rather than a rewrite.

### Zotero

Zotero stays the bibliography of record. Set `ZOTERO_LIBRARY_ID` and
`ZOTERO_API_KEY` and `/admin/sources` grows a **Sync from Zotero** button; the
worker pulls the library in and keeps it in step. Nothing is ever pushed back,
and the key needs read access only.

Sync is incremental. Each run stores the library version it reached and asks
Zotero only for what changed since, so a routine sync is one request. **Full
resync** starts again from zero — useful after editing many records at once, or
after rolling the schema back.

What each side owns is fixed, and is the whole reason the sync is safe to run
repeatedly:

| Zotero owns                            | This side owns                                             |
| -------------------------------------- | ---------------------------------------------------------- |
| The bibliographic record (`csl_json`)  | `visibility` — imports are private, always                 |
| Title, container, year, URL, DOI, ISBN | The slug, and therefore every `[[cite:…]]` already written |
| Item type                              | Archive, archive location, call number, accessed date      |
|                                        | Summary and notes                                          |

The archival fields are the subtle half. They live in `csl_json` as well as in
their own columns, and Chicago renders them from the JSON — so a sync that took
Zotero's record wholesale would strip a fond and dosar reference out of every
footnote while the column beside it still held the value. A field already
recorded here always wins; one Zotero supplies and this side lacks is taken.

**The first sync adopts what is already here** rather than duplicating it. An
unlinked source is matched on DOI, then on ISBN, then on an exact title and
year — and anything that matches more than one candidate is imported as new and
named in the job log, because a wrong link would silently overwrite a record on
every future sync.

**A deletion in Zotero is reported, not obeyed.** The link is flagged and the
source is listed with a _Deleted in Zotero_ badge. It may already be cited, and
removing it would leave a dangling reference in finished prose, so the decision
stays with the operator.

The worker needs outbound HTTPS to `api.zotero.org`. If it has none, the job
fails with the reason on its row and nothing is half-applied.

### Citations

Sources are stored as **CSL-JSON**, the interchange format Zotero, Pandoc and
citeproc all speak. Chicago output is produced by citeproc against a vendored
CSL style; this project writes no citation formatting of its own, because
Chicago's edge cases are where citation bugs live.

The same data is what Pandoc needs to produce PDF, DOCX, HTML or LaTeX, with
no conversion step in between — the web page and the compiled document render
the same CSL-JSON against the same style file.

One Markdown-plus-CSL-JSON source feeds all four outputs. PDF goes through
XeLaTeX (Tectonic), which fetches only the TeX packages a document actually
uses. LaTeX is offered as an output, not as an intermediate: LaTeX → Word is
lossy for exactly the things a dissertation depends on — footnotes, citations,
floats, tracked changes — so DOCX is produced from the same source directly.

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

That rule reaches everything derived from content, not just pages:

- A private essay that mentions a public person does not appear on that
  person's page — not its title, not its slug, not a sentence quoted from it.
- A manuscript's public contents list omits private sections **entirely**,
  with no gap or "section withheld" placeholder, and prev/next numbering is
  computed over the filtered list so a reader never sees a skipped step.
- The network graph never traverses _through_ a private node, so the shape of
  the drawing cannot betray one sitting between two public ones.
- A citation to a source the viewer may not see is withheld rather than
  rendered, in the browser and in a compiled document alike.

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

Those two must be real values. The application refuses to start in production
while `DB_PASSWORD` is still the `change-me` placeholder, because that string
is published in this repository.

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

**`web` and `worker` must share `/data/files`.** Compilation hands work across
that volume: the web app writes the assembled Markdown there and the worker
reads it back. The Compose files already mount the same volume into both; keep
that true if you split the roles across hosts.

### On AWS or another cloud host

Set `DB_HOST` in `.env` to your RDS endpoint. The compose file reads that value
rather than pinning the bundled service name, so nothing else in it needs
editing for the application to connect.

Then remove the bundled database, which is two edits in `docker-compose.yml`:

1. Delete the `db` service.
2. Delete the `depends_on: db` block from **both** `web` and `worker`. Compose
   refuses to start a composition that depends on a service which no longer
   exists, so leaving these behind fails immediately.

`DB_ROOT_PASSWORD` becomes unused — it only ever fed the bundled container.

The schema uses no MySQL features RDS lacks. Storage stays on a mounted volume
(EBS or EFS); an S3 backend is a contained change behind the storage interface,
not yet built.

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

### Compiling a manuscript

From the outline page (`/admin/manuscripts/:id/outline`), choose a format and
an audience and press build. The web app assembles the document immediately
and queues the render; the worker picks it up on its next poll, so a PDF of a
long manuscript appears a little after the page returns rather than blocking
it. Builds are listed on the same page with their state, section count and
word count, and a download link once they succeed.

**Build for the audience you mean.** An `admin` build contains every section
you can see, private ones included. A `public` build is assembled as an
anonymous reader and contains only what is already published — which is the
one to send anybody. Both are downloadable only while signed in, and the
filename records which it was (`manuscript-public-12.pdf`).

If a build fails, its row carries Pandoc's stderr; the usual causes are a
malformed YAML value on the manuscript's title-page fields and, for PDF, a TeX
package Tectonic could not fetch because the container has no outbound
network.

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

Requires Node 22.9+, Python 3.11+ and a MySQL 8 server.

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

cp .env.example .env
npm run build
npm run migrate
npm run admin -- create-admin
npm run dev               # http://localhost:8080
```

`.env.example` is the **production** template, so four values need changing for
local work:

| Value                      | Why                                                                               |
| -------------------------- | --------------------------------------------------------------------------------- |
| `NODE_ENV=development`     | Production refuses the placeholder password and insecure cookies                  |
| `DB_HOST=127.0.0.1`        | `db` is the compose service name; it resolves to nothing outside Docker           |
| `DB_PASSWORD=…`            | Whatever your local MySQL account uses                                            |
| `WEBAUTHN_RP_ID=localhost` | Already the default, and the only host a browser treats as secure over plain HTTP |

`start`, `dev`, `migrate` and `admin` load `.env` through Node's
`--env-file-if-exists`, which is why the minimum is 22.9 rather than 22.0.
Variables already set in the environment win over the file, so
`DB_HOST=other npm run migrate` still works. `npm test` deliberately does
**not** load it: the integration suites drop every table in the database they
are given, and they read `TEST_DB_*`, so pulling `.env` in would be a way to
lose a development database to a typo.

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

With no database reachable they skip rather than fail, so the unit suites still
run. That is convenient locally and dangerous anywhere else — a run that
skipped every visibility test is green and proves nothing — so set
`REQUIRE_TEST_DB=1` to make an unreachable database an error instead.

### Continuous integration

`.github/workflows/ci.yml` runs the same gate on every pull request, in three
independent jobs:

| Job          | Runs                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`       | format, typecheck, lint, build, then vitest against a MySQL 8.4 service container with `REQUIRE_TEST_DB=1`                                                                                          |
| `python`     | the pinned pandoc, then ruff and pytest                                                                                                                                                             |
| `migrations` | refuses a change that edits or deletes a migration already on `main`                                                                                                                                |
| `docker`     | builds the image for amd64 and arm64 and smoke-tests each — runs as uid 1000, pandoc and tectonic present, every declared Python dependency installed, built assets landed, dev dependencies pruned |

A separate `codeql` workflow runs static analysis on both languages, and again
weekly on `main` — advisories arrive after a merge as well as before one.

`docker` reaches out to Debian mirrors and GitHub releases, so it can go red
without a code change; nothing depends on it. It runs once per architecture:
the arm64 job builds and executes under QEMU, which is slow but is the only
thing that proves the Dockerfile's aarch64 pandoc and tectonic downloads are
the right binaries rather than merely the right size.

The `node` job also enforces the rules that used to live only in `CLAUDE.md`:
what may bypass template autoescaping, the CSP's ban on inline styles and
un-nonced scripts, and the visibility chokepoint. Both audits
(`npm audit`, `pip-audit`) run against **production** dependencies only —
what actually ships, not what happens to be in a runner.

CI installs the **same pinned pandoc `.deb`** the image does
(`.github/scripts/install-pandoc.sh` and the `PANDOC_VERSION` arg in the
`Dockerfile`), so the end-to-end citation test validates the binary that
actually renders your dissertation. Bumping the version means changing both.

### Layout

```
src/
  config.ts          Environment parsing and validation
  db/                Connection pool, migration runner
  auth/              Password, WebAuthn, sessions, CSRF, recovery codes
  content/           Repositories, the visibility chokepoint, slugs, audit
                     references, markdown, mentions, manuscripts, builds, graph
  citations/         CSL-JSON model, citeproc rendering, vendored CSL style
  files/             Hash-addressed storage, magic-byte typing, serving
  http/              Server assembly, security headers, error handling
  routes/            auth, admin-*, public-*
  views/             Nunjucks templates
  cli/               Administrative command line
public/js/           Vanilla enhancement: passkey, editor, graph
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
