/**
 * Chicago Manual of Style rendering, via citeproc and a vendored CSL style.
 *
 * Chicago has a very large number of edge cases -- corporate authors, archival
 * material, edited volumes, translated titles, subsequent short notes. Writing
 * those rules by hand is where citation bugs live, so this module does no
 * formatting of its own: it hands CSL-JSON to citeproc and passes the result
 * through a strict sanitiser.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import citeproc from 'citeproc';
import type { CitationItem, Engine, Sys } from 'citeproc';
import type { CslItem } from './csl.js';

// citeproc is CommonJS with dynamically-assigned exports, so `Engine` is not
// visible to Node's named-export detection and must come off the default.
const { Engine: CiteprocEngine } = citeproc;

const STYLE_PATH = fileURLToPath(
  new URL('./styles/chicago-notes-bibliography.csl', import.meta.url),
);
const LOCALE_PATH = fileURLToPath(new URL('./styles/locales-en-US.xml', import.meta.url));

/**
 * Tags citeproc's HTML output may contain.
 *
 * citeproc escapes anything outside CSL's small inline-markup whitelist, and
 * rejects tags carrying attributes -- verified in `tests/unit/citations.test.ts`
 * with hostile field values. This list is the second gate: even if a future
 * citeproc or style change emitted something else, it would be escaped rather
 * than rendered, so bibliographic data supplied by a Zotero import can never
 * become script in the page.
 */
const ALLOWED_TAGS = new Set([
  '<i>',
  '</i>',
  '<b>',
  '</b>',
  '<sup>',
  '</sup>',
  '<sub>',
  '</sub>',
  '<span style="font-variant:small-caps;">',
  '<span class="csl-left-margin">',
  '<span class="csl-right-inline">',
  '</span>',
  '<div class="csl-entry">',
  '</div>',
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escapes every tag that is not on the allowlist, leaving the rest untouched.
 *
 * Character entities citeproc already emitted (`&#60;`, `&amp;`) are preserved
 * verbatim -- re-escaping them would display "&amp;#60;" to the reader.
 */
export function sanitizeCitationHtml(html: string): string {
  return html.replace(/<[^>]*>/g, (tag) => (ALLOWED_TAGS.has(tag) ? tag : escapeHtml(tag)));
}

/**
 * The processor, built once per process.
 *
 * Parsing the 240 KB style file takes long enough that doing it per request
 * would be noticeable. citeproc's registry is replaced by `updateItems` on
 * every render, so reuse does not leak state between items.
 *
 * `makeCitationCluster` is used rather than `processCitationCluster` precisely
 * because it does not register the citation: every note renders in its full
 * first-reference form, which is what a standalone page needs. A document
 * export that wants "Ibid." and short forms will drive the processor
 * differently, over the whole document at once.
 */
let engine: Engine | undefined;
let registry: Record<string, CslItem> = {};

function getEngine(): Engine {
  if (engine === undefined) {
    const style = readFileSync(STYLE_PATH, 'utf8');
    const locale = readFileSync(LOCALE_PATH, 'utf8');

    const sys: Sys = {
      // Only en-US is vendored; the style requests it by name.
      retrieveLocale: () => locale,
      retrieveItem: (id) => {
        const item = registry[id];
        if (item === undefined) {
          throw new Error(`citeproc requested unknown item "${id}"`);
        }
        return item;
      },
    };

    engine = new CiteprocEngine(sys, style, 'en-US');
    engine.setOutputFormat('html');
  }
  return engine;
}

function load(items: readonly CslItem[]): Engine {
  registry = Object.fromEntries(items.map((item) => [item.id, item]));
  const active = getEngine();
  active.updateItems(items.map((item) => item.id));
  return active;
}

/**
 * Renders the bibliography entry for one source.
 *
 * Returns sanitised HTML without citeproc's wrapping `<div class="csl-entry">`,
 * so the template controls the surrounding element.
 */
export function renderBibliographyEntry(item: CslItem): string {
  const result = load([item]).makeBibliography();
  if (result === false) return '';

  const [, entries] = result;
  const entry = entries[0];
  if (entry === undefined) return '';

  return sanitizeCitationHtml(
    entry
      .replace(/^\s*<div class="csl-entry">/, '')
      .replace(/<\/div>\s*$/, '')
      .trim(),
  );
}

/** Renders a full bibliography, sorted by the style's own rules. */
export function renderBibliography(items: readonly CslItem[]): string[] {
  if (items.length === 0) return [];

  const result = load(items).makeBibliography();
  if (result === false) return [];

  const [, entries] = result;
  return entries.map((entry) =>
    sanitizeCitationHtml(
      entry
        .replace(/^\s*<div class="csl-entry">/, '')
        .replace(/<\/div>\s*$/, '')
        .trim(),
    ),
  );
}

export interface NoteOptions {
  /** Page, folio or other pinpoint reference, e.g. "45-47". */
  locator?: string | undefined;
  /** CSL locator label, e.g. 'page', 'folio', 'volume'. */
  label?: string | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
}

/**
 * Renders the Chicago footnote form for one source.
 *
 * Always the full first-reference note; see the comment on the engine.
 */
export function renderNote(item: CslItem, options: NoteOptions = {}): string {
  const citationItem: CitationItem = { id: item.id };
  if (options.locator !== undefined && options.locator !== '') {
    citationItem.locator = options.locator;
    citationItem.label =
      options.label === undefined || options.label === '' ? 'page' : options.label;
  }
  if (options.prefix !== undefined && options.prefix !== '') citationItem.prefix = options.prefix;
  if (options.suffix !== undefined && options.suffix !== '') citationItem.suffix = options.suffix;

  return sanitizeCitationHtml(load([item]).makeCitationCluster([citationItem]).trim());
}

/**
 * Discards the cached processor.
 *
 * Only used by tests that need to prove reuse does not leak state between
 * renders; production code should never need to call this.
 */
export function resetCitationEngine(): void {
  engine = undefined;
  registry = {};
}
