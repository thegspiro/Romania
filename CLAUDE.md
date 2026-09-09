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

### Templates

- Nunjucks with autoescape on.
- `| safe` is permitted **only** for citeproc output, which has already been
  through `sanitizeCitationHtml`. Never mark user-supplied text safe.
- The CSP forbids inline styles and inline scripts. There are no `style=`
  attributes; scripts carry `nonce="{{ nonce }}"`.
- Every form carries `<input type="hidden" name="_csrf" value="{{ csrfToken }}">`.

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
the integration tests ran.** Check the output.

New or changed behaviour needs a test. Anything touching visibility, auth or
SQL needs an integration test against a real database, because that is where
the properties being asserted actually live.

---

## Where things are

| Concern                               | File                        |
| ------------------------------------- | --------------------------- |
| Who may see what                      | `src/content/visibility.ts` |
| Config validation                     | `src/config.ts`             |
| Chicago rendering, HTML sanitising    | `src/citations/render.ts`   |
| CSL-JSON model, form mapping          | `src/citations/csl.ts`      |
| Passkey ceremonies                    | `src/auth/webauthn.ts`      |
| Sessions, CSRF comparison, IP packing | `src/auth/session.ts`       |
| Security headers, CSP, robots policy  | `src/http/security.ts`      |
| Request lifecycle                     | `src/http/server.ts`        |
| Slugs (mirrored in Python)            | `src/content/slug.ts`       |
| Job runner                            | `worker/runner.py`          |

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

Admin UI for artifacts, essays, people, places and events (the schema is
there); file upload; maps and network graphs (Leaflet and Cytoscape are
vendored, coordinates and edges are in the schema); Pandoc export (the
toolchain is in the image).

Each is its own change set. Keep them that way — the point of the foundation
is that they are additive.
