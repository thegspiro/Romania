/**
 * Released government records: the catalogue a declassified document carries
 * beside its bibliographic record.
 *
 * A State Department cable or a CIA report is a source -- one item, holding
 * its PDF, cited with `[[cite:...]]` -- plus a `source_government_record` row
 * holding the identifiers it is found again by. Migration 0016 records why
 * that is a separate table rather than columns on `source_detail`.
 *
 * This module owns three things:
 *
 *   * reading and validating the form fields,
 *   * writing the row inside the source's own save transaction,
 *   * `citableCsl`, the one place catalogue fields reach a citation.
 *
 * Nothing here reads content on its own, so nothing here takes a `Viewer`:
 * every read of this table is a LEFT JOIN inside a source read that already
 * applies `visibilityFilter`.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { execute, type PoolConnection } from '../db/pool.js';
import type { CslItem } from '../citations/csl.js';

/**
 * Field name, column and length limit, in the order the form shows them.
 *
 * One table drives the form reader, the SQL and the search columns, so a field
 * cannot be added to one and forgotten in another.
 */
export const GOVERNMENT_TEXT_FIELDS = [
  { field: 'originatingAgency', column: 'originating_agency', max: 255 },
  { field: 'documentType', column: 'document_type', max: 100 },
  { field: 'fromParty', column: 'from_party', max: 255 },
  { field: 'toParty', column: 'to_party', max: 255 },
  { field: 'originalClassification', column: 'original_classification', max: 100 },
  { field: 'cableNumber', column: 'cable_number', max: 100 },
  { field: 'crestNumber', column: 'crest_number', max: 100 },
  { field: 'foiaCaseNumber', column: 'foia_case_number', max: 100 },
  { field: 'frusVolume', column: 'frus_volume', max: 255 },
  { field: 'frusDocumentNumber', column: 'frus_document_number', max: 50 },
  { field: 'naraRecordGroup', column: 'nara_record_group', max: 50 },
  { field: 'naraEntry', column: 'nara_entry', max: 100 },
  { field: 'naraBox', column: 'nara_box', max: 50 },
  { field: 'naraFolder', column: 'nara_folder', max: 255 },
  { field: 'releaseCollection', column: 'release_collection', max: 255 },
] as const;

export const GOVERNMENT_DATE_FIELDS = [
  { field: 'declassifiedOn', column: 'declassified_on', label: 'Declassification date' },
  { field: 'releasedOn', column: 'released_on', label: 'Release date' },
] as const;

type TextField = (typeof GOVERNMENT_TEXT_FIELDS)[number]['field'];
type DateField = (typeof GOVERNMENT_DATE_FIELDS)[number]['field'];

/** The form's view of the record: every field a string, blank when unset. */
export type GovernmentRecordInput = Record<TextField | DateField, string>;

/** The stored record. Dates are 'YYYY-MM-DD'; a DATE is a day, not an instant. */
export type GovernmentRecord = Record<TextField | DateField, string | null>;

/**
 * The identifiers a search for a pasted number should reach.
 *
 * Every text field rather than a hand-picked few: a researcher who remembers
 * only "it was the Bucharest legation, to the Secretary" should find it too.
 */
export const GOVERNMENT_SEARCH_COLUMNS: readonly string[] = GOVERNMENT_TEXT_FIELDS.map(
  (entry) => entry.column,
);

/** Columns to add to a SELECT that LEFT JOINs the table as `alias`. */
export function governmentSelectColumns(alias: string): string {
  assertAlias(alias);
  const text = GOVERNMENT_TEXT_FIELDS.map(
    (entry) => `${alias}.${entry.column} AS gov_${entry.column}`,
  );
  // DATE_FORMAT rather than the driver's Date: a calendar day must not pass
  // through a timezone on its way to the form.
  const dates = GOVERNMENT_DATE_FIELDS.map(
    (entry) => `DATE_FORMAT(${alias}.${entry.column}, '%Y-%m-%d') AS gov_${entry.column}`,
  );
  // The primary key says whether a row exists at all, independently of which
  // fields happen to be filled.
  return [`${alias}.content_item_id AS gov_present`, ...text, ...dates].join(',\n  ');
}

/**
 * Aliases are interpolated into SQL, so they are held to the same strict
 * pattern `visibilityFilter` uses. They only ever come from this codebase.
 */
function assertAlias(alias: string): void {
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(alias)) {
    throw new Error(`unsafe SQL alias: ${alias}`);
  }
}

/** Reads the joined columns back off a row; null when the source has no record. */
export function governmentRecordFromRow(row: RowDataPacket): GovernmentRecord | null {
  if (row.gov_present === null || row.gov_present === undefined) return null;

  const read = (column: string): string | null => {
    const value: unknown = row[`gov_${column}`];
    return typeof value === 'string' && value !== '' ? value : null;
  };

  const record = {} as GovernmentRecord;
  for (const entry of GOVERNMENT_TEXT_FIELDS) record[entry.field] = read(entry.column);
  for (const entry of GOVERNMENT_DATE_FIELDS) record[entry.field] = read(entry.column);
  return record;
}

// --- Form ------------------------------------------------------------------

export function emptyGovernmentInput(): GovernmentRecordInput {
  const input = {} as GovernmentRecordInput;
  for (const entry of GOVERNMENT_TEXT_FIELDS) input[entry.field] = '';
  for (const entry of GOVERNMENT_DATE_FIELDS) input[entry.field] = '';
  return input;
}

/** The stored record in the flat shape the form template reads. */
export function governmentFormValues(record: GovernmentRecord | null): GovernmentRecordInput {
  const values = emptyGovernmentInput();
  if (record === null) return values;
  for (const key of Object.keys(values) as (keyof GovernmentRecordInput)[]) {
    values[key] = record[key] ?? '';
  }
  return values;
}

/**
 * Reads the government-record fields from a form body.
 *
 * `read` is the route's own field reader, so `unknown` bodies are narrowed in
 * one place for the whole form.
 */
export function readGovernmentForm(read: (name: string) => string): {
  input: GovernmentRecordInput;
  errors: string[];
} {
  const input = emptyGovernmentInput();
  const errors: string[] = [];

  for (const entry of GOVERNMENT_TEXT_FIELDS) {
    const value = read(entry.field).trim();
    if (value.length > entry.max) {
      errors.push(`${labelFor(entry.field)} is too long (${entry.max} characters maximum).`);
    }
    input[entry.field] = value;
  }

  for (const entry of GOVERNMENT_DATE_FIELDS) {
    const value = read(entry.field).trim();
    if (value !== '' && parseCalendarDay(value) === null) {
      errors.push(`${entry.label} must be a full date, YYYY-MM-DD.`);
    }
    input[entry.field] = value;
  }

  return { input, errors };
}

const LABELS: Readonly<Record<TextField, string>> = {
  originatingAgency: 'Originating agency',
  documentType: 'Document type',
  fromParty: 'From',
  toParty: 'To',
  originalClassification: 'Original classification',
  cableNumber: 'Cable number',
  crestNumber: 'CREST document number',
  foiaCaseNumber: 'FOIA case number',
  frusVolume: 'FRUS volume',
  frusDocumentNumber: 'FRUS document number',
  naraRecordGroup: 'NARA record group',
  naraEntry: 'NARA entry',
  naraBox: 'NARA box',
  naraFolder: 'NARA folder',
  releaseCollection: 'Release collection',
};

export function labelFor(field: TextField): string {
  return LABELS[field];
}

/**
 * A strict calendar day, or null.
 *
 * Unlike a CSL date this does not accept "1998" or "c. 1943": the two dates
 * here are stamped on the released copy, and a partial one would sort as the
 * first of January without saying so.
 */
export function parseCalendarDay(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Rejects 1998-02-31, which Date would roll over to March.
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function isBlank(input: GovernmentRecordInput): boolean {
  return Object.values(input).every((value) => value.trim() === '');
}

// --- Writes ----------------------------------------------------------------

/**
 * Writes the record inside the caller's transaction.
 *
 * A form with every field blank deletes the row: the row's existence is what
 * marks a source as a government record, and a source that has had every
 * identifier cleared is no longer one.
 */
export async function saveGovernmentRecord(
  connection: PoolConnection,
  sourceId: number,
  input: GovernmentRecordInput,
): Promise<void> {
  if (isBlank(input)) {
    await execute(connection, 'DELETE FROM source_government_record WHERE content_item_id = ?', [
      sourceId,
    ]);
    return;
  }

  const columns = [
    ...GOVERNMENT_TEXT_FIELDS.map((entry) => entry.column),
    ...GOVERNMENT_DATE_FIELDS.map((entry) => entry.column),
  ];
  const values = [
    ...GOVERNMENT_TEXT_FIELDS.map((entry) => blankToNull(input[entry.field])),
    ...GOVERNMENT_DATE_FIELDS.map((entry) => parseCalendarDay(input[entry.field].trim())),
  ];

  // Column names come from the constant above, never from input.
  await execute(
    connection,
    `INSERT INTO source_government_record (content_item_id, ${columns.join(', ')})
     VALUES (?, ${columns.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${columns.map((column) => `${column} = VALUES(${column})`).join(', ')}`,
    [sourceId, ...values],
  );
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// --- Citation --------------------------------------------------------------

/**
 * "RG 59, entry 205, box 6662, folder Romania 1947", from whichever parts
 * are recorded. The abbreviations are Chicago's own for NARA material.
 */
export function naraLocation(record: GovernmentRecord): string | null {
  const parts = [
    record.naraRecordGroup === null ? null : `RG ${record.naraRecordGroup}`,
    record.naraEntry === null ? null : `entry ${record.naraEntry}`,
    record.naraBox === null ? null : `box ${record.naraBox}`,
    record.naraFolder === null ? null : `folder ${record.naraFolder}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(', ');
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The CSL item a citation is rendered from.
 *
 * The stored CSL record always wins. A catalogue field fills a CSL variable
 * only where that variable is absent, so a footnote the operator has already
 * shaped by hand -- or that came from Zotero -- renders exactly as before:
 *
 *   genre            <- document type             "Telegram"
 *   number           <- cable number, else CREST  "Telegram no. 312"
 *   archive_location <- NARA RG, entry, box, folder
 *   archive          <- release collection
 *
 * Applied at render time and never written back, so the Zotero sync, which
 * replaces `csl_json` wholesale, cannot strip it. The FRUS fields are left
 * out on purpose: a FRUS document is a chapter of a published volume and is
 * cited as one, through the ordinary CSL fields.
 *
 * Every path that hands a source to citeproc or to Pandoc goes through this
 * function, so the web footnote and the compiled document agree.
 */
export function citableCsl(csl: CslItem, record: GovernmentRecord | null): CslItem {
  if (record === null) return csl;

  const item: CslItem = { ...csl };
  const fill = (key: string, value: string | null): void => {
    if (value !== null && isEmpty(item[key])) item[key] = value;
  };

  fill('genre', record.documentType);
  fill('number', record.cableNumber ?? record.crestNumber);
  fill('archive_location', naraLocation(record));
  fill('archive', record.releaseCollection);

  return item;
}
