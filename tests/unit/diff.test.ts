/**
 * The line diff behind the revision comparison.
 *
 * What matters is that it never claims a change that did not happen and never
 * hides one that did: the operator uses this page to decide whether to restore
 * a revision, and a diff that quietly drops a line would make that decision on
 * a false picture.
 */
import { describe, expect, it } from 'vitest';
import { collapseUnchanged, diffLines, type DiffLine } from '../../src/content/diff.js';

function textOf(lines: DiffLine[], kind: DiffLine['kind']): string[] {
  return lines.filter((line) => line.kind === kind).map((line) => line.text);
}

describe('diffLines', () => {
  it('reports nothing for identical text', () => {
    const result = diffLines('one\ntwo\nthree', 'one\ntwo\nthree');

    expect(result.summary).toEqual({ added: 0, removed: 0, identical: true });
    expect(result.lines.every((line) => line.kind === 'equal')).toBe(true);
  });

  it('finds an inserted line and leaves the rest equal', () => {
    const result = diffLines('one\nthree', 'one\ntwo\nthree');

    expect(textOf(result.lines, 'added')).toEqual(['two']);
    expect(textOf(result.lines, 'removed')).toEqual([]);
    expect(result.summary.added).toBe(1);
  });

  it('finds a deleted line', () => {
    const result = diffLines('one\ntwo\nthree', 'one\nthree');

    expect(textOf(result.lines, 'removed')).toEqual(['two']);
    expect(result.summary).toEqual({ added: 0, removed: 1, identical: false });
  });

  it('reads a changed line as one removal and one addition', () => {
    const result = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');

    expect(textOf(result.lines, 'removed')).toEqual(['two']);
    expect(textOf(result.lines, 'added')).toEqual(['TWO']);
  });

  it('numbers lines against the side they belong to', () => {
    const result = diffLines('a\nb', 'a\nx\nb');
    const added = result.lines.find((line) => line.kind === 'added');
    const last = result.lines[result.lines.length - 1];

    // An added line has no place in the older text, and says so.
    expect(added?.oldNumber).toBeNull();
    expect(added?.newNumber).toBe(2);
    expect(last).toMatchObject({ kind: 'equal', oldNumber: 2, newNumber: 3 });
  });

  it('keeps every line of the original somewhere in the result', () => {
    const older = 'alpha\nbeta\ngamma\ndelta';
    const newer = 'alpha\ngamma\nepsilon\ndelta';
    const result = diffLines(older, newer);

    const recovered = result.lines
      .filter((line) => line.kind !== 'added')
      .map((line) => line.text)
      .join('\n');
    expect(recovered).toBe(older);

    const rebuilt = result.lines
      .filter((line) => line.kind !== 'removed')
      .map((line) => line.text)
      .join('\n');
    expect(rebuilt).toBe(newer);
  });

  it('treats a trailing whitespace change as a change', () => {
    // Two trailing spaces are a hard line break in Markdown. Collapsing that
    // difference would hide a real edit to how the prose renders.
    const result = diffLines('a line', 'a line  ');
    expect(result.summary.identical).toBe(false);
    expect(result.summary.added).toBe(1);
  });

  it('does not invent a change from a trailing newline', () => {
    expect(diffLines('one\ntwo\n', 'one\ntwo').summary.added).toBe(0);
    expect(diffLines('one\ntwo\n', 'one\ntwo').summary.removed).toBe(0);
  });

  it('handles an empty side', () => {
    expect(diffLines('', 'first line').summary).toEqual({
      added: 1,
      removed: 0,
      identical: false,
    });
    expect(diffLines('gone', '').summary).toEqual({ added: 0, removed: 1, identical: false });
  });

  it('normalises CRLF so a line ending alone is not a diff', () => {
    expect(diffLines('one\r\ntwo', 'one\ntwo').summary.added).toBe(0);
  });

  it('degrades to a wholesale replacement rather than hanging on a huge text', () => {
    // Past the cap the quadratic table would be minutes of work; saying
    // "everything replaced" is honest about what it did.
    const older = Array.from({ length: 4100 }, (_, index) => `line ${index}`).join('\n');
    const newer = `${older}\nand one more`;

    const result = diffLines(older, newer);
    expect(result.summary.removed).toBe(4100);
    expect(result.summary.added).toBe(4101);
  });
});

describe('collapseUnchanged', () => {
  const changeAt = (index: number, total: number): DiffLine[] =>
    Array.from({ length: total }, (_, at) => ({
      kind: at === index ? ('added' as const) : ('equal' as const),
      oldNumber: at + 1,
      newNumber: at + 1,
      text: `line ${at}`,
    }));

  it('keeps context around a change and reports what it dropped', () => {
    const hunks = collapseUnchanged(changeAt(10, 20), 3);

    expect(hunks).toHaveLength(1);
    // Seven lines before the window, and the window itself is 3 + 1 + 3.
    expect(hunks[0]?.skipped).toBe(7);
    expect(hunks[0]?.lines).toHaveLength(7);
  });

  it('never drops a changed line', () => {
    const lines = changeAt(0, 40).concat(changeAt(39, 40));
    const kept = collapseUnchanged(lines, 2).flatMap((hunk) => hunk.lines);

    const changes = lines.filter((line) => line.kind !== 'equal').length;
    expect(kept.filter((line) => line.kind !== 'equal')).toHaveLength(changes);
  });

  it('returns nothing when there is nothing to show', () => {
    const allEqual: DiffLine[] = [
      { kind: 'equal', oldNumber: 1, newNumber: 1, text: 'same' },
      { kind: 'equal', oldNumber: 2, newNumber: 2, text: 'also same' },
    ];
    expect(collapseUnchanged(allEqual)).toEqual([]);
  });

  it('leaves a short diff alone', () => {
    const lines = changeAt(1, 4);
    const hunks = collapseUnchanged(lines, 3);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.skipped).toBe(0);
    expect(hunks[0]?.lines).toHaveLength(4);
  });
});
