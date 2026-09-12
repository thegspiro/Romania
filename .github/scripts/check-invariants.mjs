/**
 * Enforces the rules CLAUDE.md states in prose.
 *
 * These are not style preferences. This application holds unpublished
 * doctoral research about named people, and each rule below is one of the
 * things standing between that and a disclosure. Until now they held because
 * review caught them, which is not a mechanism.
 *
 * Every check passes on the tree as it stands, so this locks in the current
 * state rather than demanding a cleanup.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Expressions permitted to bypass Nunjucks autoescaping.
 *
 * Two sources only, per CLAUDE.md: citeproc output that has already been
 * through sanitizeCitationHtml, and renderProse/renderFragment output built
 * by markdown-it with `html: false`. Adding an entry here is a deliberate act
 * a reviewer will see -- which is the entire point of the list.
 */
const SAFE_ALLOWLIST = new Map([
  // citeproc, via src/citations/render.ts -> sanitizeCitationHtml
  ['preview.bibliography', 'citeproc'],
  ['preview.note', 'citeproc'],
  ['bibliographyEntry', 'citeproc'],
  ['source.entry', 'citeproc'],
  ['entry', 'citeproc'],
  ['note', 'citeproc'],
  ['note.html', 'citeproc'],
  // markdown-it with HTML disabled, via src/content/markdown.ts
  ['rendered.html', 'renderProse'],
  ['summaryHtml', 'renderFragment'],
  ['biographyHtml', 'renderFragment'],
  ['abstractHtml', 'renderFragment'],
  // An artifact's transcription is prose, rendered by renderProse in
  // src/routes/public-content.ts with the request's viewer -- so a reference
  // the viewer may not follow is already escaped text by the time it is here.
  ['transcriptionHtml', 'renderProse'],
]);

/** A line may opt out of the visibility rule by explaining itself. */
const VISIBILITY_OPT_OUT = /visibility-literal-ok:/;

/** Comment syntaxes that can precede a flagged line: SQL, JS, and JSDoc. */
const COMMENT_LINE = /^\s*(--|\/\/|\*|\/\*)/;

/**
 * Whether a line carries the opt-out marker, or sits directly beneath a
 * comment block that does.
 *
 * The marker is allowed above rather than only inline because a real
 * justification runs to a sentence or two, and cramming that onto the end of a
 * SQL line makes both harder to read. The search stops at the first
 * non-comment line, so it cannot reach past the block that introduces it.
 */
function hasOptOut(lines, index) {
  if (VISIBILITY_OPT_OUT.test(lines[index])) return true;
  for (let above = index - 1; above >= 0 && COMMENT_LINE.test(lines[above]); above -= 1) {
    if (VISIBILITY_OPT_OUT.test(lines[above])) return true;
  }
  return false;
}

const failures = [];

function fail(file, line, message) {
  failures.push(`${relative(ROOT, file)}:${line}  ${message}`);
}

function walk(dir, extension) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path, extension));
    else if (name.endsWith(extension)) found.push(path);
  }
  return found;
}

function eachLine(file, visit) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, index) => visit(text, index + 1));
}

// --- Templates -------------------------------------------------------------

for (const file of walk(join(ROOT, 'src/views'), '.njk')) {
  eachLine(file, (text, number) => {
    // A comment discussing `| safe` is not a use of it.
    const isComment = /^\s*(\{#|#|\*)/.test(text) || text.includes('{#');

    if (!isComment) {
      for (const match of text.matchAll(/\{\{\s*([^}|]+?)\s*\|\s*safe\b/g)) {
        const expression = match[1];
        if (!SAFE_ALLOWLIST.has(expression)) {
          fail(
            file,
            number,
            `\`${expression} | safe\` bypasses autoescaping and is not allowlisted. ` +
              `Only citeproc output (already through sanitizeCitationHtml) and ` +
              `renderProse/renderFragment output may be marked safe. If this is one ` +
              `of those, add it to SAFE_ALLOWLIST in this script with the reason.`,
          );
        }
      }
    }

    // The CSP forbids inline styles, so a style= attribute would silently not
    // apply -- and relaxing the CSP to make it work is the thing to prevent.
    if (/\sstyle\s*=\s*["']/.test(text)) {
      fail(file, number, 'inline style= attribute; the CSP forbids inline styles');
    }

    // Every script must carry the per-response nonce, or the CSP blocks it.
    if (/<script\b/.test(text) && !/\bnonce=/.test(text)) {
      fail(file, number, '<script> without nonce="{{ nonce }}"; the CSP will block it');
    }
  });
}

// --- SQL -------------------------------------------------------------------

// src/content/visibility.ts is the single place that decides what a viewer may
// see. A visibility literal anywhere else is either a second copy of that rule
// or something that merely looks like one -- and the difference has to be
// stated by whoever wrote it, not guessed at by a reviewer later.
const CHOKEPOINT = join(ROOT, 'src/content/visibility.ts');

for (const file of walk(join(ROOT, 'src'), '.ts')) {
  if (file === CHOKEPOINT) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, index) => {
    if (!/visibility\s*(=|<>|!=)\s*'(public|private)'/.test(text)) return;
    if (hasOptOut(lines, index)) return;
    fail(
      file,
      index + 1,
      'visibility literal in SQL outside src/content/visibility.ts. Use ' +
        'visibilityFilter(viewer). If this is genuinely not a viewer decision, say so ' +
        'in a comment on the line or immediately above it: visibility-literal-ok: <reason>',
    );
  });
}

// --- Pinned images ---------------------------------------------------------

// The MySQL digest is written in several places -- the compose file, and one
// service container per CI job that needs a database -- and those jobs' whole
// claim is that the migrations, the visibility suites and the restore drill
// passed against the database production runs. Hand-kept copies cannot promise
// that: the day one diverges, CI goes green against a database nobody deploys.
// Same reasoning as the shared slug fixture -- one edit has to move them all,
// or a check has to notice that it did not.
//
// Every occurrence is collected, not the first: a second service container was
// added to a CI job while this check existed, and a first-match-per-file
// version would have declared the tree clean with it still unpinned.
const MYSQL_IMAGE = /image:\s*mysql:8\.4(@sha256:[0-9a-f]{64})?/g;

const mysqlPins = [];
for (const file of [join(ROOT, 'docker-compose.yml'), join(ROOT, '.github/workflows/ci.yml')]) {
  const contents = readFileSync(file, 'utf8');
  const lines = contents.split('\n');
  let found = 0;

  lines.forEach((text, index) => {
    MYSQL_IMAGE.lastIndex = 0;
    const match = MYSQL_IMAGE.exec(text);
    if (match === null) return;
    found += 1;
    if (match[1] === undefined) {
      fail(file, index + 1, 'mysql:8.4 is not digest-pinned. Pin it as mysql:8.4@sha256:<64 hex>.');
      return;
    }
    mysqlPins.push({ file, line: index + 1, digest: match[1].slice(1) });
  });

  if (found === 0) {
    fail(file, 1, 'no mysql:8.4 image found. If it moved, this check needs updating.');
  }
}

const distinct = new Set(mysqlPins.map((pin) => pin.digest));
if (distinct.size > 1) {
  const first = mysqlPins[0];
  for (const pin of mysqlPins.slice(1)) {
    if (pin.digest === first.digest) continue;
    fail(
      pin.file,
      pin.line,
      `mysql digest ${pin.digest} does not match ${relative(ROOT, first.file)}:${first.line} ` +
        `(${first.digest}). CI would then test against a database production does not run. ` +
        'Change them together.',
    );
  }
}

// --- Secrets the web service must not be handed ----------------------------

// `env_file: [.env]` hands the whole file to every service that uses it, so a
// credential added for the worker reaches the internet-facing container too --
// readable from /proc and from `docker inspect` whether or not any code there
// reads it. That is not hypothetical: the Zotero key arrived this way, while
// CLAUDE.md said the web service never holds it.
//
// So every secret-looking variable .env.example documents must be either read
// by src/ or explicitly emptied in the `web` service. Adding the next
// worker-only credential then fails here until somebody decides which it is.
const SECRET_SUFFIX = /(_KEY|_PASSWORD|_SECRET|_TOKEN)$/;

/** The `web:` service block, by indentation -- no YAML parser needed. */
function webServiceBlock(contents) {
  const lines = contents.split('\n');
  const start = lines.findIndex((line) => /^ {2}web:\s*$/.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const composePath = join(ROOT, 'docker-compose.yml');
const webBlock = webServiceBlock(readFileSync(composePath, 'utf8'));
if (webBlock === null) {
  fail(composePath, 1, 'no `web:` service found; this check needs updating.');
} else {
  // Names src/ actually LOOKS UP, not names it merely mentions. The first
  // version of this check asked whether the string appeared anywhere under
  // src/, and ZOTERO_API_KEY appears in a help message on the sources page --
  // so the one leak that motivated the check was the one case it passed.
  const ENV_LOOKUP =
    /(?:read|readSecret)\(\s*env\s*,\s*'([A-Z][A-Z0-9_]*)'|process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*'([A-Z][A-Z0-9_]*)')/g;

  const readByWeb = new Set();
  for (const file of walk(join(ROOT, 'src'), '.ts')) {
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.matchAll(ENV_LOOKUP)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name !== undefined) readByWeb.add(name);
    }
  }

  const documented = new Set();
  const envExample = join(ROOT, '.env.example');
  for (const line of readFileSync(envExample, 'utf8').split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1] !== undefined) documented.add(match[1]);
  }

  // A NAME_FILE variant is the same secret by another delivery route, so the
  // base name's verdict governs both. config.ts builds it as `${name}_FILE`,
  // which is why searching src/ for the literal would never find it.
  const bases = new Set(
    [...documented]
      .map((name) => name.replace(/_FILE$/, ''))
      .filter((name) => SECRET_SUFFIX.test(name)),
  );

  for (const base of [...bases].sort()) {
    if (readByWeb.has(base)) continue;
    for (const name of [base, `${base}_FILE`]) {
      if (!documented.has(name)) continue;
      if (webBlock.includes(`${name}: ''`)) continue;
      fail(
        composePath,
        1,
        `${name} is documented in .env.example, is never read under src/, and is not ` +
          'emptied in the `web` service -- so env_file hands the internet-facing container ' +
          `a credential it cannot use. Add "${name}: ''" to web's environment, or read it.`,
      );
    }
  }
}

// --- Unraid templates ------------------------------------------------------
//
// unraid/*.xml restate configuration that lives in .env.example: a Community
// Applications template describes one container in full, so there is no
// `env_file` to point at. Two copies of a configuration surface drift, and the
// drift is silent -- an operator installing from the template simply never
// sets the value, and the container fails at startup with a message about a
// variable they were never shown.
//
// So every Variable a template names must be one .env.example documents. This
// catches a rename or a removal; it deliberately does NOT require the reverse,
// because most of .env.example is optional and a template that exposed all of
// it would be unusable.

const UNRAID_DIR = join(ROOT, 'unraid');

if (existsSync(UNRAID_DIR)) {
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const documentedNames = new Set(
    [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );

  // Set by the entrypoint or the image rather than by .env.example, so they are
  // legitimately absent from it.
  const NOT_FROM_ENV_EXAMPLE = new Set(['RUN_MIGRATIONS']);

  for (const file of walk(UNRAID_DIR, '.xml')) {
    const contents = readFileSync(file, 'utf8');

    // Parsed with a regex rather than an XML library on purpose: this script
    // has no dependencies, and a malformed template fails the shape check
    // below rather than passing silently.
    if (!/<Container\s+version="2">/.test(contents)) {
      fail(file, 1, 'not a <Container version="2"> template; CA will not read it.');
      continue;
    }
    // Lowercase because GHCR rejects an uppercase path and this repository is
    // "Romania"; the tag is part of the match so a stray uppercase one is caught
    // as well.
    if (!/<Repository>ghcr\.io\/[a-z0-9._/-]+(:[a-z0-9._-]+)?<\/Repository>/.test(contents)) {
      fail(file, 1, 'Repository must be the published, lowercase ghcr.io image reference.');
    }
    if (!/<PostArgs>(web|worker)<\/PostArgs>/.test(contents)) {
      fail(file, 1, 'PostArgs must select a role -- <PostArgs>web</PostArgs> or worker.');
    }

    for (const match of contents.matchAll(/<Config\b[^>]*\bType="Variable"[^>]*>/g)) {
      const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
      if (target === undefined) continue;
      if (NOT_FROM_ENV_EXAMPLE.has(target)) continue;
      if (documentedNames.has(target)) continue;
      const number = contents.slice(0, match.index).split('\n').length;
      fail(
        file,
        number,
        `${target} is offered by this template but is not documented in .env.example. ` +
          'Either it was renamed there, or the template is offering a variable nothing reads.',
      );
    }
  }
}

// --- Report ----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`invariant check failed (${failures.length}):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nThese rules are documented in CLAUDE.md.');
  process.exit(1);
}

console.log(
  'invariants hold: safe-filter allowlist, no inline styles, nonced scripts, visibility chokepoint, ' +
    'matching mysql pin, no stray secrets on web, unraid templates in step',
);
