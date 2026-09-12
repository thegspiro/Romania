# CLAUDE.md

Guidance for Claude Code and other agents working in this repository.
Read `README.md` first for what the project is; this file is about how to
change it without breaking it.

---

## The one thing that must never break

This application holds unpublished doctoral research about named people. The
single failure that would make it unusable is **material becoming readable
before the operator chose to publish it**.

Everything below follows from that.

`src/content/visibility.ts` is the only place that decides what a viewer may
see. Three invariants hold, and `tests/integration/visibility.test.ts` pins
each one:

1. **A private item is 404, never 403.** A 403 confirms the item exists at
   that slug, and confirmation is itself a disclosure here.
2. **A public page never leaks a private reference.** Not its title, not its
   slug, not its id — it renders as plain text, not a link.
3. **File bytes go through a route that re-checks visibility** on every
   request. Storage keys are content hashes and are never guessable.

Rules that follow:

- Every read path takes a `Viewer` and applies `visibilityFilter`.
- **Never write `visibility = 'public'` into a WHERE clause anywhere else.**
  One chokepoint is auditable; a rule scattered across handlers is not.
- New content defaults to `private` in the schema. Do not change that default.
- A visibility filter supplied by a query string is honoured only for an
  administrator — otherwise `?visibility=private` becomes an enumeration tool.
- There is **one** exception, and it lives inside the chokepoint rather than
  around it: a `share` viewer. A valid share link widens `visibilityFilter` by
  exactly one content item id and nothing else, so a private person, source or
  essay named in the shared chapter stays withheld from the holder. It is
  expressed as a `Viewer` kind on purpose — a share served by a read that
  skipped the filter would mean two answers to "may this viewer see this?", and
  only one of them auditable. `tests/integration/share-links.test.ts` pins the
  widening and what it does not reach.
- `canView` deliberately does **not** honour a share viewer's extra id. It is
  asked about reference targets, and the answer for a link holder is the same
  as for a visitor: only if published.

---

## Architecture in one page

**One image, three roles.** `web` (Fastify + Nunjucks), `worker` (Python), and
a MySQL 8 database. The entrypoint's first argument selects the role.

**Content model.** Everything publishable is a `content_item` row plus a
kind-specific detail table keyed 1:1 on it. This exists so cross-referencing,
visibility, tagging, search and the relationship graph are implemented once.

> Adding an entity type = one detail table + one repository + templates.
> If a change requires touching how linking or visibility works, stop and
> reconsider the design — that is the seam this model exists to protect.

**Citations.** Sources are stored as CSL-JSON and rendered by citeproc against
a vendored CSL style. **Never hand-write Chicago formatting.** Chicago has
hundreds of edge cases; the style file already handles them.

**Job queue.** A MySQL table claimed with `FOR UPDATE SKIP LOCKED`. No Redis.
Enqueue in the same transaction as the data that caused the job.

**References are one syntax with two meanings**, parsed by
`src/content/references.ts`:

```
[[person:ion-antonescu|Antonescu]]   a mention  -> link on the web, plain text in print
[[cite:hooligan-year|45-47]]         a citation -> footnote on the web and in print
```

`mention` and `citation` rows are **projections of the prose**, rebuilt
wholesale by `rebuildReferences` in the same transaction as the save that
changed the text. Nothing else writes them — no diffing, no reconciliation
job, no admin form. That is what makes "everywhere this person is mentioned"
trustworthy, and it is why `mention` has no visibility column of its own: a
mention is exactly as visible as the item whose prose contains it.

Backlink reads filter on the **citing** item. A private essay naming a public
person must not surface on that person's public page.

A `mention` also records `block_index`: which top-level block of the citing
prose the reference sat in, so a backlink lands on the paragraph rather than
the top of the page. It is part of the same projection — computed by
`blockAnchorsFor` from the numbering `renderProse` emits as `id="pN"`, so a
stored anchor always addresses a paragraph that exists. Both come from one
walk in `src/content/markdown.ts`; do not add a second.

**Chronology lives in `src/content/timeline.ts`.** Two rules follow from
`event_detail` storing partial dates in a `DATE` column:

- `1944-01-01` at `year` precision **means "1944"**. `formatEventDate` is the
  only place a stored date becomes a human one, so nothing else can claim a
  certainty the record does not carry. Templates print the string it returned.
- An event's **place is joined with the viewer's filter in the ON clause**, so
  a private place makes the place disappear, never the event. The result is
  indistinguishable from an event that was never given one.
- The precision ladder covers the clock too (`hour`, `minute`). A time is
  stored nullable and shown only when the precision reaches it, so coarsening
  an event's precision withdraws the claim without losing the value.
- An event the sources will not date but do **place** carries `happened_after`
  edges instead. The chronology puts it at the start of the window its visible
  anchors allow and draws the whole window, marked as uncertain, so a reader
  cannot mistake it for a dated fact. Bounds are filtered on the edge **and**
  the anchor _before_ the window is computed: filtering afterwards would leave
  a private event's date deciding where a public one sits on the band, which
  discloses it without ever naming it.

Prose may embed a chronology as a fenced ```timeline block, resolved by
`resolveTimelines` before rendering — the same shape as `resolveForRender`, so
the published page, the admin preview and a compiled document agree. For
Pandoc, `timelinesToPandoc` turns the block into ordinary Markdown in
TypeScript, with the build's `Viewer` already applied; the worker never learns
the syntax exists.
**A relationship edge may carry an office and a period.** `role_title`,
`start_date`, `end_date` and `date_precision` live on `relationship`, not on
either endpoint, because an office is a property of the connection. Two posts
at one organization are two edges — which is why the unique key includes the
generated `period_key`, a STORED column folding NULL to `''`. Do not narrow
that key back to the bare triple: MySQL treats NULLs in a unique index as
distinct, so the old duplicate check only still works because of that column.

The graph accepts an optional year, and filters asserted edges by interval
overlap. An **undated edge is always drawn** — an unknown period is not an
absent one. The year is ANDed on top of `visibilityFilter`, never in place of
it; a filter that could make a private node reachable would be a leak, and
`tests/integration/graph.test.ts` pins that it cannot.

**An artifact's transcription is its prose column.** Like an essay's body and
an agent's biography, it goes through `rebuildReferences` in the save
transaction -- `createArtifact` and `updateArtifact` both call it, and nothing
else writes `mention`. One prose column per kind, for the reason the entity
specs give: the projection is rebuilt wholesale from one string, and a
mention's context and paragraph anchor have to point somewhere definite.

It renders through `renderProse` with the request's viewer, so the
visible/not-visible decision stays in the renderer rather than being made again
on the page. `transcriptionHtml` is on the `| safe` allowlist for that reason
and no other.

`transcription_language` is deliberately not `content_item.language`: one
describes the text, the other the catalogue record, and a German order in a
Romanian archive needs both.

**A file can be owned by an artifact or a source.** `FILE_OWNERS` in
`src/files/repository.ts` is the one place that names them, so adding a third
owner is editing that constant and nothing else. Two rules ride on it:

- `findServableFile` is invariant 3 in one query. A `file_object` that **no**
  item owns stays unreachable through `/files/:id/:variant` -- that is what
  keeps a compiled manuscript build off this route, and it must survive any
  change to the join.
- Storage is content-addressed, so one file may have several owners. The rule
  is **servable if any owning item is visible**: the bytes are one object, and
  there is no coherent way for them to be public and private at once.
  `tests/integration/source-files.test.ts` states that outright so it reads as
  a decision rather than an accident of a `LIMIT 1`.

Detaching a file clears the column and leaves `file_object` alone, because
another item may still own it.

**The export exists so the research can leave.** `src/content/export.ts`
writes Markdown, CSL-JSON and a JSON catalogue -- deliberately nothing this
application invented, because the risk to a five-year dissertation is not a
bug, it is that nobody can build the image in 2031.

- Reference syntax is exported **as written**. Resolving `[[cite:x]]` into a
  link here would bake this application's idea of a reference into the copy
  meant to outlive it. It is already readable text keyed to a slug.
- Every read goes through a repository, so `visibilityFilter` applies. A
  `--public` export is assembled with `ANONYMOUS` and is the same kind of
  object as a `public` manuscript build: one file holding everything at once.
  `tests/integration/export.test.ts` pins that it leaks no private prose, no
  private artifact, and no storage key.
- `artifactFileKeys` is the one read that goes around `ArtifactRecord`, because
  no _page_ needs a storage key and an export does. It applies the filter like
  anything else; keep it that way.

`scripts/restore-rehearsal.sh` runs the whole drill and CI runs it on every
pull request. Three things it is written to avoid, all of which bit this script
before it worked: POSIX sh has no `pipefail` and `set -e` sees only the last
command of a pipeline, so the export is captured to a file rather than piped
into `sed`; a failed count query must not fall back to `0`, because two zeroes
compare equal and the check would pass having compared nothing; and the drill
creates a scratch database, which the application's user is not expected to be
allowed to do -- hence `REHEARSAL_DB_USER`, and a step 0 that proves the
privilege before a backup has been written.

**Essay revisions are append-only, and written in the save transaction.**
`essay_revision` holds whole snapshots, not diffs -- the row _is_ the text, so
there is no reconstruction step that could be wrong. Three rules:

- A revision records the state **after** a save, so the newest revision always
  equals `essay_detail`. `tests/integration/essay-revisions.test.ts` pins that.
  Change it and "restore revision N" is off by one.
- Revision numbers are allocated inside `updateEssay`'s transaction, which
  already holds `FOR UPDATE` on the `content_item` row. That lock is what stops
  two saves claiming one number; do not move the numbering outside it.
- **Restoring is an ordinary save.** It goes through `updateEssay`, so
  `rebuildReferences` runs and a new revision is appended. Nothing rewinds and
  nothing in the history is rewritten. A restore must never carry `visibility`
  back: publication is a decision about now, and silently republishing old
  prose is exactly the disclosure this application exists to prevent.

The revision reads take no `Viewer` on purpose -- a revision is unpublished
draft text by definition, the routes are behind the admin guard and check the
essay with `findEssayById` first, and there is no public path to one. Do not
add a viewer parameter; it would imply there could be.

**A map is a second view of rows the place pages already show.**
`src/content/places.ts` reads through `visibilityFilter` like anything else, so
a private place is _absent_ from the overview rather than withheld with a gap,
and `/map/places.json` is filtered identically -- it is the same read, not a
way around it. A place with no coordinates is simply not a point; an unmapped
place and a place that does not exist look the same, which is the intended
behaviour.

`geocode_precision` travels with every point and the marker says which it is. A
town geocoded to its modern centre is not evidence about where a building stood
in 1941, and a map is the one surface where being approximately right reads as
being precisely right.

**The tile host is the only third party this application can ever contact, and
it is off by default.** `MAP_TILE_URL` unset means markers on a plain canvas and
no request leaving this origin -- which is the same rule that vendors browser
libraries instead of loading them from a CDN. Tiles are worse than a library
CDN, and that is why the default is off rather than a helpful OpenStreetMap
URL: tile requests encode the coordinates and zoom being viewed, so the host
learns which places are being read, including the private ones an administrator
is reviewing. Set, exactly one origin is added to `img-src` and nowhere else;
`tileOrigin` parses it from the template, and a `{s}` subdomain placeholder is
rejected at startup because a pattern cannot become one CSP source.

**Geocoding is queued, never called from the web.** The button enqueues
`place.geocode` and `worker/jobs/geocode.py` does the lookup, for the same
reason the Zotero key lives only in the worker. The payload key is
`contentItemId` -- the worker's name for it, not the web's. The handler refuses
to overwrite coordinates entered by hand, so a stray click cannot replace the
operator's own judgement about where something was.

**Zotero sync pulls; it never pushes.** `worker/jobs/zotero_sync.py` is the
only thing that talks to the API, and the web service never holds the key --
it enqueues `zotero.sync` and reads the state back for the listing. That was
true of the code and false of the container until `docker-compose.yml` emptied
`ZOTERO_API_KEY` for `web`: `env_file` loads the whole of `.env` everywhere it
appears, and an environment variable is readable from `/proc` whether or not
anything reads it. `check-invariants.mjs` now fails on the next credential
that arrives the same way. Two
invariants make a repeated sync safe:

- `source_zotero_link` is unique on `(library_type, library_id, item_key)`.
  That is what makes the sync an upsert rather than an append, and why a run
  that failed halfway can simply be retried.
- **The slug is set once, at creation.** References are keyed to it, so a title
  corrected in Zotero updates the title and never the URL.

`_merge_local_fields` carries `archive`, `archive_location`, `call-number` and
`accessed` forward from the stored record. Those live in `csl_json` _and_ in a
column, and Chicago renders them from the JSON -- dropping the merge would take
a call number out of every footnote while the column still showed it. Do not
"simplify" the update into a straight replacement.

A deletion in Zotero sets `deleted_in_zotero_at` and stops. Deleting the source
would leave a dangling `[[cite:...]]` in prose already written.

**A share link is a credential, and `resolveShare` is the only door.** It
hashes the token, looks it up, and refuses expired and revoked links; every
caller goes through it, so the two checks cannot be remembered at one call site
and forgotten at another. The refusal reason is logged and never returned --
unknown, expired and revoked all answer 404, because distinguishing them says
whether a chapter exists behind a guessed token.

- Only `sha256(token)` is stored, like a session token and a recovery code.
  The token is returned once, by `issueShare`, and cannot be recovered.
- `essay_share_comment.share_id` is ON DELETE SET NULL, not CASCADE: revoking
  a link must not delete the feedback that came through it.
- `block_index` on a comment is an anchor, not a foreign key. Prose is edited,
  and a comment whose paragraph is gone is shown unanchored rather than
  discarded.
- `/review/` responses are `no-store` and `no-referrer`. The credential is in
  the URL, so a referrer header would hand it to every host the page links to.

**Manuscripts are a flat ordered list with a depth column**, not a
self-referencing tree. Ordering, prev/next, subtree moves and compilation are
all simple walks over it, and MySQL's self-referencing foreign keys have
awkward cascade behaviour. It renders as a nested outline regardless.

**Compilation: TypeScript assembles, Python renders.** The web app walks the
outline for a `Viewer`, demotes headings, rewrites references into Pandoc
syntax and stages `document.md` plus `references.json`; the worker runs
Pandoc over them and stores the output.

> The worker makes **no visibility decisions** and does no reference parsing.
> Moving either into `worker/` would put a second copy of the rule outside the
> chokepoint, or a second parser to fall out of step. Don't.

A compiled file holds many sections at once, so it is the one place a mistake
would leak everything. `manuscript_build.audience` records what it was
assembled for; a `public` build is assembled with `ANONYMOUS`, and the
download route requires an authenticated administrator. Compiled outputs are
deliberately not reachable through `/files/:id/:variant` — no artifact owns
them, so that route 404s for them, which is the intended behaviour and is
tested.

---

## Conventions

### TypeScript

- ESM throughout; import paths carry the `.js` extension (`NodeNext`).
- `strict` plus `noUncheckedIndexedAccess`. Do not weaken `tsconfig.json`.
- No `any`. Narrow `unknown` explicitly — request bodies arrive as `unknown`
  and are read field by field.
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- The server logs through Fastify's logger. `console` is allowed only in
  `src/cli/**` and `src/db/migrate.ts`, which are terminal programs.

### SQL

- **Always bound parameters.** Never build SQL from values by concatenation
  or interpolation.
- The application pool is created with `multipleStatements: false`. Only the
  migration runner enables it, and only for trusted files on disk.
- Two places legitimately write SQL text: `limitOffsetClause` (digits only,
  after asserting safe integers) and the alias in `visibilityFilter` (matched
  against a strict pattern). Do not add a third without the same rigour.
- Escape user input in `LIKE` patterns — see `escapeLike` in
  `src/content/sources.ts`. Unescaped, a search for `%` matches everything.

### Fastify hooks — a real trap

Fastify decides how to drive a hook **from its arity**:

- Fewer than three parameters → Fastify awaits the returned value. A
  synchronous hook written this way **hangs every request**.
- Three parameters (`done`) → synchronous contract; a throw is routed to the
  error handler.

Use `async` when there is something to await, and the `done` form when there
is not. This bit us once already; both forms are in the codebase with
comments explaining which is which.

### Markdown

- markdown-it, configured `html: false`. Raw HTML in an essay body is escaped,
  not sanitised — there is nothing to get wrong later.
- References are a real **inline rule**, not a string substitution over the
  source. That is why `` `[[person:x]]` `` inside a code span stays literal.
- The renderer is the only place the visible/not-visible decision becomes
  markup. A target the viewer may not see renders as **escaped display text
  and nothing else** — no `href`, no `title`, no slug, no id.

### Templates

- Nunjucks with autoescape on.
- `| safe` is permitted **only** for citeproc output, which has already been
  through `sanitizeCitationHtml`, and for `renderProse` output, which is built
  by markdown-it with HTML disabled. Never mark user-supplied text safe.
- The CSP forbids inline styles and inline scripts. There are no `style=`
  attributes; scripts carry `nonce="{{ nonce }}"`.
- Every form carries `<input type="hidden" name="_csrf" value="{{ csrfToken }}">`.
- Client JavaScript is progressive enhancement. The editor's picker, the
  preview and the graph all have a server-rendered equivalent above them; if
  the script does not run, nothing is lost but convenience.

### Python

- `worker/` only. Ruff-clean, `line-length = 100`, Python 3.11 target.
- Handlers must be **idempotent**: the runner retries them.
- Type hints on everything; `from __future__ import annotations` at the top.

### Migrations

- Numbered SQL pairs: `NNNN_name.up.sql` and `NNNN_name.down.sql`.
- **Every up-migration needs a tested down-migration.** An untested rollback
  is discovered when a rollback is already needed.
- MySQL commits implicitly around DDL, so a failed migration cannot roll
  back. Write up-migrations to be **re-runnable** — use the `IF NOT EXISTS`
  and `INSERT IGNORE` forms.
- **Never edit an applied migration.** The runner stores a checksum and will
  refuse to start. Add a new migration instead.
- No ORM auto-migration, ever. The schema is reviewed as SQL, in the diff.

---

## Never do these

- Weaken the CSP, or add `unsafe-inline`.
- Store a session token, password or recovery code in plaintext. Sessions
  store `sha256(token)`; passwords and codes are Argon2id.
- Log a cookie, an `Authorization` header or a `Set-Cookie` (they are redacted
  in the logger config — do not remove that).
- Return a 403 where the existence of the item is itself sensitive.
- Restrict `authenticatorAttachment` or request attestation in the WebAuthn
  options. Both would hide Bitwarden and other credential managers from the
  browser's prompt, which is the operator's primary authenticator.
- Trust `X-Forwarded-*` unconditionally — `TRUST_PROXY` gates it, because
  without a proxy in front a client can spoof its own IP and defeat login
  throttling.
- Turn on `ALLOW_SEARCH_INDEXING` by default. Crawled research cannot be
  un-crawled.
- Add a client-side framework. The site is server-rendered HTML by choice.
- Load anything from a CDN. Browser libraries are vendored from `node_modules`
  by `scripts/vendor-assets.mjs`, so no third party sees a visitor's IP.
- Write to `mention` or `citation` from anywhere but `rebuildReferences`. A
  hand-edited projection is a listing that no longer matches the prose.
- Serve a compiled build to anyone but an authenticated administrator, or
  assemble a `public` build with anything but `ANONYMOUS`.
- Put a visibility decision, or reference parsing, into `worker/`.
- Leave a gap or a "withheld" placeholder where a private section was filtered
  out of a listing. The absence must be indistinguishable from never having
  existed.

---

## Before you claim a change is done

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
.venv/bin/ruff check worker/ && .venv/bin/pytest
```

Integration tests need MySQL 8 and drop every table in the target database:

```sh
TEST_DB_HOST=127.0.0.1 TEST_DB_NAME=dissertation_test \
TEST_DB_USER=dissertation TEST_DB_PASSWORD=… npm test
```

Without a database they skip rather than fail — so **a green run does not mean
the integration tests ran.** Check the output, or set `REQUIRE_TEST_DB=1` to
turn an unreachable database into a failure:

```sh
REQUIRE_TEST_DB=1 npm test
```

CI sets it, so a pull request cannot go green with the visibility suites
silently absent. Locally it is opt-in, and without it the skip still works.

### Rules CI now enforces

These were prose until they were checks. `.github/scripts/check-invariants.mjs`
runs in the `node` job and fails on:

- a `| safe` whose expression is not on its allowlist,
- an inline `style=` attribute, or a `<script>` without a nonce,
- a `visibility = '<literal>'` in a `.ts` file outside
  `src/content/visibility.ts`,
- a `mysql:8.4` image that is not digest-pinned, or whose digest differs
  between `docker-compose.yml` and any CI service container,
- a secret-looking variable in `.env.example` that `src/` never looks up and
  the `web` service does not empty -- `env_file` hands the whole file to every
  service, so a worker-only credential otherwise reaches the internet-facing
  container as well.

The last one takes an escape hatch, because not every match is a viewer
decision -- an admin dashboard counting published items is not. Put
`visibility-literal-ok: <reason>` on the line or in the comment block directly
above it. An exception nobody wrote down is indistinguishable from a mistake,
which is why a reason is required rather than a bare marker.

Adding a `| safe` means editing `SAFE_ALLOWLIST` in that script. That friction
is the point; do not widen the pattern to avoid it.

`.github/scripts/check-migrations.sh` fails a pull request that modifies or
deletes a migration already on `main`. Adding one is fine -- that is how the
schema moves.

Run both locally before pushing:

```sh
node .github/scripts/check-invariants.mjs
./.github/scripts/check-migrations.sh origin/main
```

New or changed behaviour needs a test. Anything touching visibility, auth or
SQL needs an integration test against a real database, because that is where
the properties being asserted actually live.

---

## Where things are

| Concern                                 | File                                |
| --------------------------------------- | ----------------------------------- |
| Who may see what                        | `src/content/visibility.ts`         |
| Share links, tokens, reviewer comments  | `src/content/sharing.ts`            |
| The reviewer's routes                   | `src/routes/review.ts`              |
| Config validation                       | `src/config.ts`                     |
| Chicago rendering, HTML sanitising      | `src/citations/render.ts`           |
| CSL-JSON model, form mapping            | `src/citations/csl.ts`              |
| Passkey ceremonies                      | `src/auth/webauthn.ts`              |
| Sessions, CSRF comparison, IP packing   | `src/auth/session.ts`               |
| Security headers, CSP, robots policy    | `src/http/security.ts`              |
| Request lifecycle                       | `src/http/server.ts`                |
| Slugs (mirrored in Python)              | `src/content/slug.ts`               |
| Reference syntax, context extraction    | `src/content/references.ts`         |
| Prose → HTML, the visible/not decision  | `src/content/markdown.ts`           |
| Projections and backlinks               | `src/content/mentions.ts`           |
| Corpus export, portable formats         | `src/content/export.ts`             |
| Mappable places, geocode queueing       | `src/content/places.ts`             |
| Essay revisions, restore rules          | `src/content/essays.ts`             |
| Line diff for the comparison view       | `src/content/diff.ts`               |
| Outline, navigation, assembly           | `src/content/manuscripts.ts`        |
| Build records, staging, enqueue         | `src/content/builds.ts`             |
| Graph traversal with per-hop filtering  | `src/content/graph.ts`              |
| Dates, chronological reads, the band    | `src/content/timeline.ts`           |
| Path safety, magic bytes, hashing       | `src/files/storage.ts`              |
| Access-checked file lookup, file owners | `src/files/repository.ts`           |
| Zotero sync, link and merge rules       | `worker/jobs/zotero_sync.py`        |
| Sync queueing and state for the admin   | `src/content/zotero.ts`             |
| Job runner                              | `worker/runner.py`                  |
| Pandoc invocation                       | `worker/jobs/manuscript_compile.py` |

### Pinned images

Base images are pinned by digest with the tag kept beside them, for the reason
pandoc and tectonic are: a floating tag lets the image CI validated and the
image a rebuild produces be different, and that difference never appears in a
diff. The MySQL digest is written once per place that needs a database --
`docker-compose.yml`, and one service container per CI job -- so
`check-invariants.mjs` fails when any of them is unpinned or diverges, because
CI going green against a database nobody deploys is exactly what the pin exists
to prevent. It collects every occurrence rather than the first: a second
service container was added while that check existed, and a first-match version
would have called the tree clean with it still unpinned.

Pinning also freezes the base's own security updates, so refresh deliberately:

```sh
docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect mysql:8.4 --format '{{.Manifest.Digest}}'
```

Use the multi-arch index digest, not a per-platform one: the CI matrix builds
`linux/amd64` and `linux/arm64` from the same reference.

### Two implementations that must stay in step

`slugify` exists in **both** `src/content/slug.ts` and
`worker/jobs/bibliography_import.py`, because the worker creates sources
during an import. They must agree exactly, or the same title imported one way
and typed the other produces two different URLs.

Both suites read their cases from `tests/fixtures/slug-cases.json`. Editing
that file changes both at once, so the two implementations cannot drift while
both stay green — which two hand-kept copies could not actually guarantee.

---

## What is deliberately not built yet

Public downloads of compiled documents (`manuscript_build.audience` is what
makes that a config change rather than a rewrite); search beyond `LIKE`; an S3
storage backend.

A search service such as Meilisearch is the one remaining **side-cart**
candidate, and nothing needs it today: Pandoc and Tectonic are already in the
image and MySQL handles the graph queries at this scale. Reach for a separate
service only when something truly cannot live in the application, not to avoid
writing a query.

Zotero sync used to be listed here as the other candidate. It shipped as a
worker job instead -- one handler, one migration, no new service -- which is
the precedent: the job queue and the worker are where an integration goes
until it demonstrably cannot fit there.

Each is its own change set. Keep them that way — the point of the content
model is that they are additive.
