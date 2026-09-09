/**
 * CSL-JSON: the bibliographic record's storage format.
 *
 * Sources are stored as CSL-JSON because it is the interchange format that
 * Zotero, Pandoc and citeproc all speak. Keeping the authoritative record in
 * that shape means citations render from the same data that will later be
 * handed to Pandoc for PDF, DOCX or LaTeX output, with no lossy conversion in
 * between and no second definition of "what a source is".
 */
import { z } from 'zod';

/**
 * Source types offered in the admin form.
 *
 * These are CSL item types, chosen for historical research. CSL defines many
 * more; add to this list rather than inventing local type names, because the
 * style file only knows CSL's vocabulary.
 */
export const SOURCE_TYPES = [
  { value: 'book', label: 'Book' },
  { value: 'chapter', label: 'Book chapter' },
  { value: 'article-journal', label: 'Journal article' },
  { value: 'article-magazine', label: 'Magazine article' },
  { value: 'article-newspaper', label: 'Newspaper article' },
  { value: 'manuscript', label: 'Archival document / manuscript' },
  { value: 'personal_communication', label: 'Letter / personal communication' },
  { value: 'interview', label: 'Interview' },
  { value: 'thesis', label: 'Thesis or dissertation' },
  { value: 'report', label: 'Report' },
  { value: 'paper-conference', label: 'Conference paper' },
  { value: 'speech', label: 'Speech or lecture' },
  { value: 'entry-encyclopedia', label: 'Encyclopedia entry' },
  { value: 'map', label: 'Map' },
  { value: 'motion_picture', label: 'Film' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'webpage', label: 'Web page' },
  { value: 'document', label: 'Other document' },
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number]['value'];

const SOURCE_TYPE_VALUES = SOURCE_TYPES.map((entry) => entry.value);

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && SOURCE_TYPE_VALUES.includes(value as SourceType);
}

export function sourceTypeLabel(value: string): string {
  return SOURCE_TYPES.find((entry) => entry.value === value)?.label ?? value;
}

// --- Schema ----------------------------------------------------------------

const CslNameSchema = z
  .object({
    family: z.string().optional(),
    given: z.string().optional(),
    /** Used for organizations and mononyms, which have no family/given split. */
    literal: z.string().optional(),
  })
  .refine(
    (name) => name.literal !== undefined || name.family !== undefined || name.given !== undefined,
    'a name must have at least one of literal, family or given',
  );

export type CslName = z.infer<typeof CslNameSchema>;

const CslDateSchema = z.object({
  'date-parts': z.array(z.array(z.number().int())).optional(),
  /** Free text for dates CSL cannot express, e.g. "n.d." or "c. 1943". */
  literal: z.string().optional(),
  circa: z.boolean().optional(),
});

export type CslDate = z.infer<typeof CslDateSchema>;

/**
 * The stored CSL item.
 *
 * `.loose()` keeps fields this application does not model but a Zotero import
 * may carry: dropping them on read then writing back would quietly destroy
 * data the operator imported.
 */
export const CslItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    title: z.string().optional(),
    'container-title': z.string().optional(),
    'collection-title': z.string().optional(),
    author: z.array(CslNameSchema).optional(),
    editor: z.array(CslNameSchema).optional(),
    translator: z.array(CslNameSchema).optional(),
    recipient: z.array(CslNameSchema).optional(),
    publisher: z.string().optional(),
    'publisher-place': z.string().optional(),
    volume: z.string().optional(),
    issue: z.string().optional(),
    page: z.string().optional(),
    edition: z.string().optional(),
    genre: z.string().optional(),
    medium: z.string().optional(),
    issued: CslDateSchema.optional(),
    accessed: CslDateSchema.optional(),
    archive: z.string().optional(),
    archive_location: z.string().optional(),
    'call-number': z.string().optional(),
    URL: z.string().optional(),
    DOI: z.string().optional(),
    ISBN: z.string().optional(),
    language: z.string().optional(),
    note: z.string().optional(),
  })
  .loose();

export type CslItem = z.infer<typeof CslItemSchema>;

// --- Creator parsing -------------------------------------------------------

/**
 * Parses creators typed one per line.
 *
 * "Ionescu, Maria"                -> { family: 'Ionescu', given: 'Maria' }
 * "Ministry of the Interior"      -> { literal: 'Ministry of the Interior' }
 *
 * A line without a comma becomes a literal name rather than being split on
 * whitespace: guessing which word is the surname is wrong often enough with
 * Romanian, Hungarian and institutional names to be worth refusing to guess.
 */
export function parseCreators(input: string): CslName[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const separator = line.indexOf(',');
      if (separator === -1) return { literal: line };

      const family = line.slice(0, separator).trim();
      const given = line.slice(separator + 1).trim();
      if (family === '') return { literal: given === '' ? line : given };
      if (given === '') return { family };
      return { family, given };
    });
}

/** Renders creators back into the one-per-line form used by the form. */
export function formatCreators(names: readonly CslName[] | undefined): string {
  if (names === undefined) return '';
  return names
    .map((name) => {
      if (name.literal !== undefined) return name.literal;
      if (name.family !== undefined && name.given !== undefined) {
        return `${name.family}, ${name.given}`;
      }
      return name.family ?? name.given ?? '';
    })
    .filter((line) => line !== '')
    .join('\n');
}

/** Human-readable creator list for listings, e.g. "Ionescu, Popescu". */
export function creatorSummary(names: readonly CslName[] | undefined): string {
  if (names === undefined || names.length === 0) return '';
  const surnames = names.map((name) => name.family ?? name.literal ?? name.given ?? '');
  if (surnames.length <= 2) return surnames.filter((entry) => entry !== '').join(' and ');
  return `${surnames[0] ?? ''} et al.`;
}

// --- Dates -----------------------------------------------------------------

const NUMERIC_DATE = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/;

/**
 * Parses a date entered as YYYY, YYYY-MM or YYYY-MM-DD.
 *
 * Anything else is preserved verbatim as a CSL literal date, because
 * historical sources are routinely dated "n.d.", "c. 1943" or
 * "before March 1945" and discarding that is worse than not structuring it.
 */
export function parseCslDate(input: string): CslDate | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  const match = NUMERIC_DATE.exec(trimmed);
  if (match === null) return { literal: trimmed };

  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);

  if (month !== undefined && (month < 1 || month > 12)) return { literal: trimmed };
  if (day !== undefined && (day < 1 || day > 31)) return { literal: trimmed };

  const parts: number[] = [year];
  if (month !== undefined) parts.push(month);
  if (day !== undefined) parts.push(day);

  return { 'date-parts': [parts] };
}

/** Renders a CSL date back into the form's text input. */
export function formatCslDate(date: CslDate | undefined): string {
  if (date === undefined) return '';
  if (date.literal !== undefined) return date.literal;

  const parts = date['date-parts']?.[0];
  if (parts === undefined || parts.length === 0) return '';

  return parts
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join('-');
}

/** The four-digit year, for sorting and filtering. Null when not structured. */
export function issuedYear(item: CslItem): number | null {
  const year = item.issued?.['date-parts']?.[0]?.[0];
  return typeof year === 'number' && Number.isInteger(year) ? year : null;
}

// --- Building --------------------------------------------------------------

export interface SourceFormInput {
  id: string;
  cslType: string;
  title: string;
  authors: string;
  editors: string;
  translators: string;
  containerTitle: string;
  collectionTitle: string;
  publisher: string;
  publisherPlace: string;
  volume: string;
  issue: string;
  page: string;
  edition: string;
  genre: string;
  medium: string;
  issued: string;
  accessed: string;
  archive: string;
  archiveLocation: string;
  callNumber: string;
  url: string;
  doi: string;
  isbn: string;
  language: string;
  note: string;
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalNames(value: string): CslName[] | undefined {
  const names = parseCreators(value);
  return names.length === 0 ? undefined : names;
}

/**
 * Builds the CSL-JSON record from admin form input.
 *
 * Empty fields are omitted rather than stored as empty strings: citeproc
 * treats an empty string as a present-but-blank value and can emit stray
 * punctuation for it.
 */
export function buildCslItem(input: SourceFormInput): CslItem {
  const item: CslItem = {
    id: input.id,
    type: input.cslType,
  };

  const assign = <K extends keyof CslItem>(key: K, value: CslItem[K] | undefined): void => {
    if (value !== undefined) item[key] = value;
  };

  assign('title', optional(input.title));
  assign('author', optionalNames(input.authors));
  assign('editor', optionalNames(input.editors));
  assign('translator', optionalNames(input.translators));
  assign('container-title', optional(input.containerTitle));
  assign('collection-title', optional(input.collectionTitle));
  assign('publisher', optional(input.publisher));
  assign('publisher-place', optional(input.publisherPlace));
  assign('volume', optional(input.volume));
  assign('issue', optional(input.issue));
  assign('page', optional(input.page));
  assign('edition', optional(input.edition));
  assign('genre', optional(input.genre));
  assign('medium', optional(input.medium));
  assign('archive', optional(input.archive));
  assign('archive_location', optional(input.archiveLocation));
  assign('call-number', optional(input.callNumber));
  assign('URL', optional(input.url));
  assign('DOI', optional(input.doi));
  assign('ISBN', optional(input.isbn));
  assign('language', optional(input.language));
  assign('note', optional(input.note));

  const issued = parseCslDate(input.issued);
  if (issued !== undefined) item.issued = issued;

  const accessed = parseCslDate(input.accessed);
  if (accessed !== undefined) item.accessed = accessed;

  return item;
}

/** Reads a stored JSON column back into a validated CSL item. */
export function parseStoredCslItem(raw: unknown): CslItem {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return CslItemSchema.parse(value);
}
