/**
 * URL slugs.
 *
 * Titles in this corpus are routinely Romanian, German or Hungarian, so
 * slugging has to transliterate rather than strip: "Bucureşti" must become
 * "bucuresti", not "bucure-ti". Unicode decomposition handles most of that,
 * with an explicit table for the characters it cannot decompose.
 */

/** Characters with no combining-mark decomposition, or where NFD is wrong. */
const TRANSLITERATIONS = new Map<string, string>([
  // Romanian comma-below forms and their cedilla lookalikes, which appear
  // interchangeably in older documents and in text copied from PDFs.
  ['ș', 's'],
  ['ş', 's'],
  ['ț', 't'],
  ['ţ', 't'],
  // German, Nordic and Slavic characters common in the surrounding literature.
  ['ß', 'ss'],
  ['ä', 'ae'],
  ['ö', 'oe'],
  ['ü', 'ue'],
  ['æ', 'ae'],
  ['ø', 'o'],
  ['å', 'a'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['þ', 'th'],
  ['ł', 'l'],
  // Cyrillic appears in archival citations; a minimal transliteration keeps
  // the slug readable instead of collapsing the whole title to empty.
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['ж', 'zh'],
  ['з', 'z'],
  ['и', 'i'],
  ['й', 'i'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['х', 'kh'],
  ['ц', 'ts'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'shch'],
  ['ъ', ''],
  ['ы', 'y'],
  ['ь', ''],
  ['э', 'e'],
  ['ю', 'yu'],
  ['я', 'ya'],
]);

export const MAX_SLUG_LENGTH = 190;

/**
 * Converts a title into a URL slug.
 *
 * Returns an empty string when the input contains nothing sluggable; callers
 * must handle that rather than producing an item with no address.
 */
export function slugify(input: string): string {
  const transliterated = [...input.toLowerCase()]
    .map((character) => TRANSLITERATIONS.get(character) ?? character)
    .join('');

  return (
    transliterated
      // Decompose accented characters and drop the combining marks.
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/, '')
  );
}

/**
 * Produces a slug that does not collide, by appending -2, -3 and so on.
 *
 * `exists` is asked about each candidate in turn. This is deliberately a
 * check-then-write rather than a loop on unique-constraint violations,
 * because the caller may need the slug before the row is inserted; the
 * database's unique key remains the actual guarantee.
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
  fallback = 'item',
): Promise<string> {
  const root = slugify(base) || fallback;

  if (!(await exists(root))) return root;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${root.slice(0, MAX_SLUG_LENGTH - tail.length).replace(/-+$/, '')}${tail}`;
    if (!(await exists(candidate))) return candidate;
  }

  throw new Error(`Could not find a free slug based on "${root}" after 999 attempts`);
}
