# AGENTS.md

Working agreement for AI agents making changes to this repository.

`CLAUDE.md` holds the architecture, conventions and invariants — **read it
first, it is not optional**. This file is about process: how to pick up a
task, what to verify, and what to escalate rather than decide.

---

## Before writing code

1. **Read `CLAUDE.md`.** The security invariants there are not style
   preferences; several of them are the reason the project is designed the
   way it is.
2. **Find the existing pattern.** Every entity type follows the same shape:
   `content_item` + detail table + repository + routes + templates. Sources
   are the worked example — copy that structure rather than inventing one.
   For anything that reads content, `visibilityFilter` and a `Viewer`
   parameter are part of the shape, not an addition to it.
3. **State the plan before implementing.** Which components (TypeScript
   service, Python worker, templates, schema), which files change, whether a
   migration is needed, what could regress.

## Scope

One logical change per change set. A bug fix is a bug fix; do not bundle a
refactor with it.

Do not, without being asked:

- rename files, reorganize folders or restructure modules
- change public interfaces, URL shapes, config variable names or the schema
  of an existing table
- add dependencies (the small dependency surface is deliberate)
- reformat code you are not otherwise touching

If a change you were asked for **requires** one of these, say so and explain
why before doing it.

---

## Stop and ask

Some things are cheap to get wrong and expensive to discover later. Raise
these rather than deciding alone:

- **Anything that could make private material public**, or that changes how
  visibility is computed. This includes anything derived from content: a
  backlink listing, a manuscript's contents, a graph traversal, a compiled
  document's contents or who may download it.
- **Making compiled documents downloadable without authentication.** The
  `audience` column exists so this is a config change, but it is the operator's
  decision, not yours.
- **A breaking schema change** — dropping or renaming a column, changing a
  type, anything that loses data. Propose a migration and rollback plan first.
- **Changes to authentication**: the WebAuthn options, session lifecycle,
  password policy, recovery codes. Note in particular that
  `authenticatorAttachment` and attestation settings decide whether the
  operator's password manager still works as an authenticator.
- **Changing `WEBAUTHN_RP_ID` semantics.** Passkeys are bound to that domain;
  a change invalidates every one of them.
- **Turning on search-engine indexing.** Crawled research cannot be
  un-crawled.
- **Deleting anything** — data, files, migrations, backups.

When requirements are ambiguous and the readings lead to materially different
work, ask. Do not invent API shapes, table names, config keys, ports or
deployment assumptions.

---

## Definition of done

A change is done when all of this passes:

```sh
npm run typecheck        # tsc --noEmit over src and tests
npm run lint             # eslint, zero errors
npm run format:check     # prettier
npm test                 # vitest
.venv/bin/ruff check worker/
.venv/bin/pytest
```

**Integration tests skip silently without a database.** A green run is not
evidence they executed — read the output, or set `REQUIRE_TEST_DB=1`, which
turns an unreachable database into a failure. CI sets it, so do not "fix" a
red CI run by unsetting it. To run them for real:

```sh
TEST_DB_HOST=127.0.0.1 TEST_DB_NAME=dissertation_test \
TEST_DB_USER=dissertation TEST_DB_PASSWORD=… npm test
```

They drop every table in the target database. Never point them at anything
but a disposable one.

### Tests are required

- New behaviour needs a test. Changed behaviour needs its test updated **and
  a reason** — a test that changes to match new output either documents a
  deliberate change or is hiding a regression.
- Visibility, authentication and SQL need **integration** tests against a real
  MySQL. The properties being asserted live in the database, and a mock proves
  nothing about them.
- Citation output is pinned to exact strings on purpose. If a style update
  changes one, every citation on the site changed — review the diff, do not
  update the expectation reflexively.

### Migrations

Ship a tested `.down.sql` with every `.up.sql`. Make up-migrations
re-runnable. Never edit a migration that has been applied — the runner stores
a checksum and will refuse to start, and CI now refuses first.

### When a guard fires

`check-invariants.mjs` and `check-migrations.sh` encode rules from
`CLAUDE.md`. Satisfy the rule; do not widen the check to get past it. The one
sanctioned escape is the `visibility-literal-ok: <reason>` marker, and it
wants a real reason — an exception nobody wrote down is indistinguishable from
a mistake.

---

## Reporting back

Say what you did, why that approach, what you traded off, and how to deploy,
migrate and test it. Then say plainly:

- what you did **not** do, and why
- anything you were unsure about
- anything a reviewer should look at particularly closely

If tests fail, say so and show the output. If you skipped part of the task,
say which part. A change set reported as complete when it is not costs more
than one reported honestly as partial.

Do not describe something as "done", "working" or "verified" unless you ran
it and watched it pass.

---

## Things that have already bitten us

Recorded so they are not rediscovered:

- **Fastify hook arity.** A hook with fewer than three parameters must return
  a promise. A synchronous two-parameter hook hangs every request — silently,
  with no error. Use `async`, or take `done`.
- **citeproc is CommonJS** with dynamically assigned exports, so a named
  import of `Engine` fails at runtime under ESM. It must be destructured off
  the default export.
- **`@node-rs/argon2` exports an ambient `const enum`**, which cannot be
  imported as a value under `verbatimModuleSyntax`.
- **citeproc passes CSL's allowed inline markup through unescaped.** It
  rejects tags with attributes, but the output still goes through
  `sanitizeCitationHtml` as a second gate. Do not remove it.
- **BibTeX encodes diacritics as LaTeX commands.** Romanian titles import as
  `Anii \cScolii` unless `decode_latex` runs first.
- **`slugify` exists in TypeScript and Python** and the two must agree
  exactly. Both suites read `tests/fixtures/slug-cases.json`, so one edit
  changes both — two hand-kept copies let them drift while both stayed green.
- **Sentence boundaries cannot be found in raw Markdown.** A sentence
  routinely ends `.[[cite:x|45]]`, where the full stop is not followed by
  whitespace and so is invisible to a boundary search. `extractContext`
  rewrites references to their display text first, tracking the anchor's new
  offset, and only then looks for boundaries.
- **`MIN(context)` picks alphabetically, not chronologically.** Backlink
  context joins the `occurrence = 0` row instead, so the reader gets the first
  mention's wording rather than a sentence from the middle of the piece.
- **`isinstance(x, int)` is true for `True` in Python.** A `buildId` of `true`
  would have reached a storage path as `builds/True`. Job payload validation
  excludes `bool` explicitly.
- **Migration assertions must be derived, not written out.** The suite reads
  the versions off disk; hard-coded lists broke on every new migration and
  stopped asserting "every migration" in the process.
- **`person` does not pluralise to `persons`.** `KIND_PATHS` is the single
  definition of every kind's URL segment; do not build one by appending "s".
