/**
 * Line diff, for comparing two revisions of an essay.
 *
 * Written here rather than pulled in as a dependency: this is forty lines of
 * well-understood algorithm, it runs on the operator's own prose and never on
 * anything a visitor supplies, and a diff library would be a third package to
 * audit for a page only the administrator can open.
 *
 * The result is **data, not markup**. Nunjucks escapes every line when it
 * renders, which is what keeps a body containing `<script>` a piece of text
 * on the comparison page rather than a hole in the CSP.
 */

export type DiffKind = 'equal' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  /** 1-based line number in the older text; null for an added line. */
  oldNumber: number | null;
  /** 1-based line number in the newer text; null for a removed line. */
  newNumber: number | null;
  text: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  /** True when the two texts are identical, including trailing whitespace. */
  identical: boolean;
}

export interface DiffResult {
  lines: DiffLine[];
  summary: DiffSummary;
}

/**
 * Above this many lines on either side the quadratic table is abandoned.
 *
 * A 20,000-line chapter would need a 400-million-cell table, which is minutes
 * of work and gigabytes of memory for a page nobody would read anyway. Past
 * the limit the comparison degrades to "everything replaced", which is honest
 * about what it is doing rather than appearing to hang.
 */
const MAX_LINES = 4000;

function splitLines(text: string): string[] {
  // A trailing newline would otherwise produce a phantom empty last line that
  // shows as a change whenever one text has it and the other does not.
  const normalised = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalised === '' ? [] : normalised.split('\n');
}

/**
 * Longest common subsequence lengths, row by row.
 *
 * Only the table is built here; the walk back through it is what produces the
 * diff. Int32Array rather than nested arrays because the table is the only
 * part of this that is ever large.
 */
function lcsTable(older: string[], newer: string[]): Int32Array {
  const rows = older.length + 1;
  const columns = newer.length + 1;
  const table = new Int32Array(rows * columns);

  for (let row = older.length - 1; row >= 0; row -= 1) {
    for (let column = newer.length - 1; column >= 0; column -= 1) {
      const index = row * columns + column;
      table[index] =
        older[row] === newer[column]
          ? (table[(row + 1) * columns + (column + 1)] ?? 0) + 1
          : Math.max(table[(row + 1) * columns + column] ?? 0, table[index + 1] ?? 0);
    }
  }
  return table;
}

/** Everything removed, then everything added. The fallback past MAX_LINES. */
function wholesale(older: string[], newer: string[]): DiffLine[] {
  return [
    ...older.map((text, index) => ({
      kind: 'removed' as const,
      oldNumber: index + 1,
      newNumber: null,
      text,
    })),
    ...newer.map((text, index) => ({
      kind: 'added' as const,
      oldNumber: null,
      newNumber: index + 1,
      text,
    })),
  ];
}

/**
 * Compares two texts line by line.
 *
 * Lines are compared exactly: a change to trailing whitespace is a change,
 * because in Markdown two trailing spaces are a line break and collapsing
 * that difference would hide a real edit.
 */
export function diffLines(olderText: string, newerText: string): DiffResult {
  const older = splitLines(olderText);
  const newer = splitLines(newerText);

  if (older.length > MAX_LINES || newer.length > MAX_LINES) {
    const lines = wholesale(older, newer);
    return {
      lines,
      summary: { added: newer.length, removed: older.length, identical: false },
    };
  }

  const columns = newer.length + 1;
  const table = lcsTable(older, newer);
  const lines: DiffLine[] = [];

  let row = 0;
  let column = 0;
  while (row < older.length && column < newer.length) {
    if (older[row] === newer[column]) {
      lines.push({
        kind: 'equal',
        oldNumber: row + 1,
        newNumber: column + 1,
        text: older[row] ?? '',
      });
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * columns + column] ?? 0) >= (table[row * columns + column + 1] ?? 0)
    ) {
      lines.push({ kind: 'removed', oldNumber: row + 1, newNumber: null, text: older[row] ?? '' });
      row += 1;
    } else {
      lines.push({
        kind: 'added',
        oldNumber: null,
        newNumber: column + 1,
        text: newer[column] ?? '',
      });
      column += 1;
    }
  }

  // Whatever is left on one side after the other ran out.
  for (; row < older.length; row += 1) {
    lines.push({ kind: 'removed', oldNumber: row + 1, newNumber: null, text: older[row] ?? '' });
  }
  for (; column < newer.length; column += 1) {
    lines.push({
      kind: 'added',
      oldNumber: null,
      newNumber: column + 1,
      text: newer[column] ?? '',
    });
  }

  const added = lines.filter((line) => line.kind === 'added').length;
  const removed = lines.filter((line) => line.kind === 'removed').length;

  return {
    lines,
    summary: { added, removed, identical: olderText === newerText },
  };
}

/**
 * Drops runs of unchanged lines, keeping `context` of them around each change.
 *
 * Without this, comparing two revisions of a chapter is a page of identical
 * prose with three altered lines somewhere inside it. A dropped run is
 * reported rather than silently closed up, so the reader can see that the
 * comparison is not the whole text.
 */
export interface DiffHunk {
  /** Unchanged lines skipped immediately before this run, or 0. */
  skipped: number;
  lines: DiffLine[];
}

export function collapseUnchanged(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);

  lines.forEach((line, index) => {
    if (line.kind === 'equal') return;
    const from = Math.max(index - context, 0);
    const to = Math.min(index + context, lines.length - 1);
    for (let at = from; at <= to; at += 1) keep[at] = true;
  });

  const hunks: DiffHunk[] = [];
  let skipped = 0;
  let current: DiffLine[] = [];

  lines.forEach((line, index) => {
    if (keep[index] === true) {
      current.push(line);
      return;
    }
    if (current.length > 0) {
      hunks.push({ skipped, lines: current });
      current = [];
      skipped = 0;
    }
    skipped += 1;
  });

  if (current.length > 0) hunks.push({ skipped, lines: current });
  return hunks;
}
