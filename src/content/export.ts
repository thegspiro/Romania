/**
 * Exporting the whole corpus into formats that outlive this application.
 *
 * A dissertation is a five-year asset and this is bespoke software. The risk
 * that matters is not a bug -- it is that in 2031 nobody can build a Node 22
 * image or run the migration chain, and the research is trapped in a MySQL
 * dump nobody can open.
 *
 * So the export deliberately produces nothing this application invented:
 *
 *   - prose as **Markdown** with YAML front matter, which any editor opens;
 *   - the bibliography as one **CSL-JSON** array, which Zotero and Pandoc
 *     both read directly;
 *   - the artifact catalogue as **JSON** carrying each file's SHA-256 and
 *     storage key, so the files in a `files-*.tar.gz` backup can be matched
 *     back to the records that describe them.
 *
 * Reference syntax is left exactly as written. `[[person:ion-antonescu]]`
 * is readable as text, keyed to a slug rather than to a database id, and
 * mechanically rewritable later; resolving it here would bake this
 * application's idea of a link into the copy meant to outlive it.
 *
 * Every read goes through a repository and therefore through
 * `visibilityFilter`. The CLI passes an administrator, so a default export
 * contains unpublished research -- which is the point, and why the directory
 * is created 0700 and the README says so.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { queryRows, type Pool, type PoolConnection } from '../db/pool.js';
import { visibilityFilter, type Viewer } from './visibility.js';
import { listEssays } from './essays.js';
import { listSources } from './sources.js';
import { listArtifacts } from './artifacts.js';
import { ENTITY_KINDS, findEntityBySlug, listEntities, type EntityKind } from './entities.js';

/** Repository listings cap at 200; this is the page size to walk them with. */
const PAGE = 200;

export interface ExportSummary {
  directory: string;
  essays: number;
  sources: number;
  artifacts: number;
  artifactFiles: number;
  entities: Record<EntityKind, number>;
  /** What the viewer could see, so the summary cannot overstate the export. */
  audience: 'admin' | 'public';
}

/**
 * A YAML scalar that cannot terminate the block early.
 *
 * JSON encoding is valid YAML for scalars, which removes any question of a
 * colon, quote or `#` in a title being read as syntax. The same trick the
 * manuscript metadata block uses.
 */
function yamlValue(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}

function frontMatter(fields: [string, string | number | boolean | null][]): string {
  const lines = fields
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}: ${yamlValue(value)}`);
  return ['---', ...lines, '---'].join('\n');
}

function day(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * A slug is already `[a-z0-9-]{1,190}`, so it cannot traverse or collide with
 * a reserved name. Asserted rather than assumed: this value becomes a path.
 */
function safeSlug(slug: string): string {
  if (!/^[a-z0-9-]{1,190}$/.test(slug)) {
    throw new Error(`Refusing to write a file for an unexpected slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

async function writeUtf8(path: string, contents: string): Promise<void> {
  await writeFile(path, contents.endsWith('\n') ? contents : `${contents}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function exportCorpus(
  pool: Pool,
  viewer: Viewer,
  directory: string,
): Promise<ExportSummary> {
  // 0700 because a default export holds unpublished research about named
  // people. The umask could widen a later mkdir, so every directory says it.
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const essays = await exportEssays(pool, viewer, directory);
  const sources = await exportSources(pool, viewer, directory);
  const { records, files } = await exportArtifacts(pool, viewer, directory);
  const entities = await exportEntities(pool, viewer, directory);

  const summary: ExportSummary = {
    directory,
    essays,
    sources,
    artifacts: records,
    artifactFiles: files,
    entities,
    audience: viewer.kind === 'admin' ? 'admin' : 'public',
  };

  await writeUtf8(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        // The format this export is written in, not the application's version.
        // A reader in 2031 needs to know how to interpret the layout, not what
        // produced it.
        formatVersion: 1,
        ...summary,
      },
      null,
      2,
    ),
  );

  await writeUtf8(join(directory, 'README.md'), readme(summary));
  return summary;
}

async function exportEssays(pool: Pool, viewer: Viewer, directory: string): Promise<number> {
  const target = join(directory, 'essays');
  await mkdir(target, { recursive: true, mode: 0o700 });

  let written = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { items } = await listEssays(pool, viewer, { limit: PAGE, offset });
    if (items.length === 0) break;

    for (const essay of items) {
      const header = frontMatter([
        ['title', essay.title],
        ['title_original', essay.titleOriginal],
        ['slug', essay.slug],
        ['language', essay.language],
        ['status', essay.status],
        ['visibility', essay.visibility],
        ['summary', essay.summary],
        ['word_count', essay.wordCount],
        ['published', day(essay.publishedAt)],
        ['updated', day(essay.updatedAt)],
      ]);
      // The body verbatim, reference syntax and all. It is readable as text
      // and keyed to slugs, so it survives without this application.
      await writeUtf8(
        join(target, `${safeSlug(essay.slug)}.md`),
        `${header}\n\n${essay.bodyMarkdown}`,
      );
      written += 1;
    }
    if (items.length < PAGE) break;
  }
  return written;
}

/**
 * The bibliography as one CSL-JSON array.
 *
 * One file rather than one per source because CSL-JSON's unit of exchange is
 * an array: this drops straight into Zotero's importer and into Pandoc's
 * `--bibliography`, which is the whole point of storing it this way.
 */
async function exportSources(pool: Pool, viewer: Viewer, directory: string): Promise<number> {
  const target = join(directory, 'sources');
  await mkdir(target, { recursive: true, mode: 0o700 });

  const items: unknown[] = [];
  const provenance: Record<string, unknown>[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const page = await listSources(pool, viewer, { limit: PAGE, offset });
    if (page.items.length === 0) break;

    for (const source of page.items) {
      // The citation key is the slug, as everywhere else, so a [[cite:x]] in
      // exported prose and the entry here still name the same work.
      items.push({ ...source.csl, id: source.slug });

      // Archive, call number and the operator's notes are what make a record
      // findable again in a reading room. CSL carries the first two; `notes`
      // has no CSL home at all, so the provenance file keeps them together
      // rather than losing the one CSL cannot express.
      if (
        source.archive !== null ||
        source.archiveLocation !== null ||
        source.callNumber !== null ||
        source.notes !== null ||
        source.fileObjectId !== null
      ) {
        provenance.push({
          id: source.slug,
          title: source.title,
          archive: source.archive,
          archive_location: source.archiveLocation,
          call_number: source.callNumber,
          accessed_on: source.accessedOn,
          notes: source.notes,
          // The scan of the work itself, if one is attached. Named the same
          // way the artifact catalogue names its files, so one reader of this
          // export learns one convention.
          file:
            source.fileObjectId === null
              ? null
              : {
                  original_filename: source.originalFilename,
                  mime_type: source.mimeType,
                  byte_size: source.byteSize,
                },
        });
      }
    }
    if (page.items.length < PAGE) break;
  }

  await writeUtf8(join(target, 'references.json'), JSON.stringify(items, null, 2));
  await writeUtf8(join(target, 'provenance.json'), JSON.stringify(provenance, null, 2));
  return items.length;
}

interface ArtifactFileRow extends RowDataPacket {
  id: number;
  slug: string;
  sha256: string | null;
  storage_key: string | null;
}

/**
 * Storage keys and hashes for the artifacts the viewer may see.
 *
 * `ArtifactRecord` carries neither, because no page needs them -- file bytes
 * are served through a route that re-checks visibility, never by path. An
 * export does need them: without the key there is no way to match a record to
 * its file inside a `files-*.tar.gz`. Read here with `visibilityFilter`
 * applied like every other read path.
 */
async function artifactFileKeys(
  db: Pool | PoolConnection,
  viewer: Viewer,
): Promise<Map<number, { sha256: string; storageKey: string }>> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<ArtifactFileRow>(
    db,
    `SELECT ci.id, ci.slug, fo.sha256, fo.storage_key
       FROM content_item ci
       JOIN artifact_detail ad ON ad.content_item_id = ci.id
       LEFT JOIN file_object fo ON fo.id = ad.file_object_id
      WHERE ci.kind = 'artifact' AND ${visible.sql}`,
    visible.params,
  );

  const keys = new Map<number, { sha256: string; storageKey: string }>();
  for (const row of rows) {
    if (row.sha256 === null || row.storage_key === null) continue;
    keys.set(Number(row.id), { sha256: String(row.sha256), storageKey: String(row.storage_key) });
  }
  return keys;
}

async function exportArtifacts(
  pool: Pool,
  viewer: Viewer,
  directory: string,
): Promise<{ records: number; files: number }> {
  const target = join(directory, 'artifacts');
  await mkdir(target, { recursive: true, mode: 0o700 });

  const keys = await artifactFileKeys(pool, viewer);
  const catalogue: Record<string, unknown>[] = [];
  let files = 0;

  for (let offset = 0; ; offset += PAGE) {
    const page = await listArtifacts(pool, viewer, { limit: PAGE, offset });
    if (page.items.length === 0) break;

    for (const artifact of page.items) {
      const file = keys.get(artifact.id);
      if (file !== undefined) files += 1;

      catalogue.push({
        slug: artifact.slug,
        title: artifact.title,
        title_original: artifact.titleOriginal,
        summary: artifact.summary,
        visibility: artifact.visibility,
        provenance: artifact.provenance,
        repository: artifact.repositoryName,
        physical_location: artifact.physicalLocation,
        date_created: artifact.dateCreated,
        credit_line: artifact.creditLine,
        rights: artifact.rightsStatement,
        file:
          file === undefined
            ? null
            : {
                original_filename: artifact.originalFilename,
                mime_type: artifact.mimeType,
                byte_size: artifact.byteSize,
                sha256: file.sha256,
                // Relative to STORAGE_ROOT, which is the `files/` prefix
                // inside a files-*.tar.gz archive.
                storage_key: file.storageKey,
              },
      });
    }
    if (page.items.length < PAGE) break;
  }

  await writeUtf8(join(target, 'artifacts.json'), JSON.stringify(catalogue, null, 2));
  return { records: catalogue.length, files };
}

async function exportEntities(
  pool: Pool,
  viewer: Viewer,
  directory: string,
): Promise<Record<EntityKind, number>> {
  const counts = { person: 0, organization: 0, place: 0, event: 0 };

  for (const kind of ENTITY_KINDS) {
    const target = join(directory, 'entities', kind);
    await mkdir(target, { recursive: true, mode: 0o700 });

    for (let offset = 0; ; offset += PAGE) {
      const { items } = await listEntities(pool, kind, viewer, { limit: PAGE, offset });
      if (items.length === 0) break;

      for (const entity of items) {
        // The listing carries no detail columns, and the detail is most of
        // what a person or a place *is*. One read each is affordable for a
        // command that runs at most daily.
        const full = await findEntityBySlug(pool, kind, entity.slug, viewer);
        if (full === null) continue;

        const detail: [string, string | number | boolean | null][] = Object.entries(
          full.detail,
        ).map(([key, value]) => [key, value]);

        const header = frontMatter([
          ['title', full.title],
          ['title_original', full.titleOriginal],
          ['slug', full.slug],
          ['kind', kind],
          ['language', full.language],
          ['visibility', full.visibility],
          ['updated', day(full.updatedAt)],
          ...detail,
        ]);

        await writeUtf8(
          join(target, `${safeSlug(full.slug)}.md`),
          `${header}\n\n${full.summary ?? ''}`,
        );
        counts[kind] += 1;
      }
      if (items.length < PAGE) break;
    }
  }

  return counts;
}

function readme(summary: ExportSummary): string {
  return `# Corpus export

Written by \`admin export\` on ${new Date().toISOString().slice(0, 10)}.

This directory is a copy of the research in formats that do not need the
application that produced them.

| Path                       | What it is                                            |
| -------------------------- | ----------------------------------------------------- |
| \`essays/*.md\`              | Prose, Markdown with YAML front matter                |
| \`sources/references.json\`  | The bibliography as CSL-JSON — import into Zotero, or pass to Pandoc with \`--bibliography\` |
| \`sources/provenance.json\`  | Archive, call number and notes, which CSL cannot carry |
| \`entities/<kind>/*.md\`     | People, organizations, places and events              |
| \`artifacts/artifacts.json\` | The artifact catalogue, with each file's SHA-256 and storage key |
| \`manifest.json\`            | Counts and the format version                         |

Artifact *files* are not in here. They are in the \`files-*.tar.gz\` written by
the same backup: each record's \`storage_key\` is the path inside that archive,
under \`files/\`, and \`sha256\` identifies the bytes independently of the path.

Prose keeps its reference syntax — \`[[person:ion-antonescu|Antonescu]]\` for a
mention, \`[[cite:hooligan-year|45-47]]\` for a citation. Both are keyed to the
slug in the front matter of the file they name, so they can be rewritten
mechanically for another tool, or read as they are.

${
  summary.audience === 'admin'
    ? `**This export contains unpublished material.** It was written for an
administrator, so it holds every item regardless of visibility, including
research about named people that has not been published. The directory is
created \`0700\`. Treat it as you would the database.`
    : `This export was written for an anonymous reader, so it contains only
material that was already published.`
}
`;
}
