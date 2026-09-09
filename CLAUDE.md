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

New or changed behaviour needs a test. Anything touching visibility, auth or
SQL needs an integration test against a real database, because that is where
the properties being asserted actually live.

---

## Where things are

| Concern                                | File                                |
| -------------------------------------- | ----------------------------------- |
| Who may see what                       | `src/content/visibility.ts`         |
| Config validation                      | `src/config.ts`                     |
| Chicago rendering, HTML sanitising     | `src/citations/render.ts`           |
| CSL-JSON model, form mapping           | `src/citations/csl.ts`              |
| Passkey ceremonies                     | `src/auth/webauthn.ts`              |
| Sessions, CSRF comparison, IP packing  | `src/auth/session.ts`               |
| Security headers, CSP, robots policy   | `src/http/security.ts`              |
| Request lifecycle                      | `src/http/server.ts`                |
| Slugs (mirrored in Python)             | `src/content/slug.ts`               |
| Reference syntax, context extraction   | `src/content/references.ts`         |
| Prose → HTML, the visible/not decision | `src/content/markdown.ts`           |
| Projections and backlinks              | `src/content/mentions.ts`           |
| Outline, navigation, assembly          | `src/content/manuscripts.ts`        |
| Build records, staging, enqueue        | `src/content/builds.ts`             |
| Graph traversal with per-hop filtering | `src/content/graph.ts`              |
| Path safety, magic bytes, hashing      | `src/files/storage.ts`              |
| Access-checked file lookup             | `src/files/repository.ts`           |
| Job runner                             | `worker/runner.py`                  |
| Pandoc invocation                      | `worker/jobs/manuscript_compile.py` |

### Two implementations that must stay in step

`slugify` exists in **both** `src/content/slug.ts` and
`worker/jobs/bibliography_import.py`, because the worker creates sources
during an import. They must agree exactly, or the same title imported one way
and typed the other produces two different URLs.

The same fixture list is asserted in `tests/unit/slug.test.ts` and
`worker/tests/test_bibliography_import.py`. **Change one, change both** — one
of the two suites will fail otherwise, which is the point.

---

## What is deliberately not built yet

Maps (Leaflet is vendored and `place_detail` carries coordinates); public
downloads of compiled documents (`manuscript_build.audience` is what makes
that a config change rather than a rewrite); search beyond `LIKE`; an S3
storage backend; Zotero sync.

The last two are the first genuine **side-cart** candidates — a search service
such as Meilisearch, and a Zotero sync service. Nothing needs one today:
Pandoc and Tectonic are already in the image and MySQL handles the graph
queries at this scale. Reach for a separate service only when something truly
cannot live in the application, not to avoid writing a query.

Each is its own change set. Keep them that way — the point of the content
model is that they are additive.
