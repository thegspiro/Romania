/**
 * Content fixtures for the integration suites.
 *
 * These go through the real repository functions rather than raw INSERTs, so a
 * fixture exercises the same slug generation, transaction boundaries and
 * projection rebuilds the application uses. A test that seeded rows by hand
 * would prove the query works against data the application cannot produce.
 */
import type { Pool } from '../../src/db/pool.js';
import { createEntity, type EntityKind } from '../../src/content/entities.js';
import { createEssay, type EssayInput } from '../../src/content/essays.js';
import { createManuscript, type ManuscriptInput } from '../../src/content/manuscripts.js';
import { createSource, type SourceInput } from '../../src/content/sources.js';
import type { Visibility } from '../../src/content/visibility.js';

export async function makeEntity(
  pool: Pool,
  kind: EntityKind,
  title: string,
  visibility: Visibility,
  detail: Record<string, string> = {},
): Promise<number> {
  return createEntity(pool, kind, {
    title,
    titleOriginal: '',
    language: '',
    summary: '',
    visibility,
    noindex: false,
    detail,
  });
}

export async function makeEssay(
  pool: Pool,
  title: string,
  visibility: Visibility,
  bodyMarkdown: string,
  overrides: Partial<EssayInput> = {},
): Promise<{ id: number; unresolved: { kind: string; slug: string }[] }> {
  const result = await createEssay(pool, {
    title,
    titleOriginal: '',
    language: '',
    summary: '',
    visibility,
    noindex: false,
    bodyMarkdown,
    status: 'draft',
    ...overrides,
  });
  return { id: result.id, unresolved: result.references.unresolved };
}

export async function makeManuscript(
  pool: Pool,
  title: string,
  visibility: Visibility,
  overrides: Partial<ManuscriptInput> = {},
): Promise<number> {
  return createManuscript(pool, {
    title,
    subtitle: '',
    summary: '',
    visibility,
    noindex: false,
    authorName: 'Test Operator',
    degree: '',
    institution: '',
    submittedOn: '',
    abstractMarkdown: '',
    acknowledgementsMarkdown: '',
    numberSections: false,
    ...overrides,
  });
}

/** Every CSL form field blank but the ones a test cares about. */
export function sourceInput(overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    cslType: 'book',
    title: 'A Cited Book',
    authors: 'Ionescu, Maria',
    editors: '',
    translators: '',
    containerTitle: '',
    collectionTitle: '',
    publisher: 'Humanitas',
    publisherPlace: 'Bucharest',
    volume: '',
    issue: '',
    page: '',
    edition: '',
    genre: '',
    medium: '',
    issued: '1998',
    accessed: '',
    archive: '',
    archiveLocation: '',
    callNumber: '',
    url: '',
    doi: '',
    isbn: '',
    language: '',
    note: '',
    titleOriginal: '',
    summary: '',
    visibility: 'public',
    noindex: false,
    ...overrides,
  };
}

export async function makeSource(
  pool: Pool,
  title: string,
  visibility: Visibility,
): Promise<number> {
  return createSource(pool, sourceInput({ title, visibility }));
}
