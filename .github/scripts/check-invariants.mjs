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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// --- Report ----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`invariant check failed (${failures.length}):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nThese rules are documented in CLAUDE.md.');
  process.exit(1);
}

console.log(
  'invariants hold: safe-filter allowlist, no inline styles, nonced scripts, visibility chokepoint',
);
