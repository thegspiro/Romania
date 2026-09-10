/**
 * Mentions as projections of prose, and the visibility rule over backlinks.
 *
 * The user-facing feature is "write about a person, link them, then from their
 * page see everywhere else they are mentioned". The property that must hold is
 * that the list is filtered on the *citing* item: a private essay that names a
 * public person must not appear on that person's public page -- not its title,
 * not its slug, and not a sentence quoted out of it.
 *
 * Requires MySQL. Without one the suite skips rather than fails; check the
 * output before believing a green run covered this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, databaseAvailable, truncateContent, type Harness } from './helpers.js';
import { makeEntity, makeEssay, makeSource } from './fixtures.js';
import type { RowDataPacket } from 'mysql2/promise';
import { queryRows } from '../../src/db/pool.js';
import { updateEssay, deleteEssay } from '../../src/content/essays.js';
import { deleteEntity } from '../../src/content/entities.js';
import {
  countMentionsOf,
  listMentionsFrom,
  listMentionsOf,
  listReferencesBlockingDeletion,
} from '../../src/content/mentions.js';
import { ANONYMOUS, adminViewer } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('mentions', () => {
  let harness: Harness;
  let admin: ReturnType<typeof adminViewer>;

  beforeAll(async () => {
    harness = await createHarness();
    admin = adminViewer(harness.userId);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  describe('projections', () => {
    it('writes one row per occurrence, with the first occurrence carrying context', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const essay = await makeEssay(
        harness.pool,
        'Report on the Commission',
        'public',
        [
          '# Report',
          '',
          'The commission met in July. [[person:ion-antonescu|The Marshal]] presided.',
          '',
          'Later [[person:ion-antonescu]] withdrew.',
        ].join('\n'),
      );

      const rows = await queryRows<
        RowDataPacket & { occurrence: number; anchor_text: string; context: string }
      >(
        harness.pool,
        'SELECT occurrence, anchor_text, context FROM mention WHERE from_item_id = ? AND to_item_id = ? ORDER BY occurrence',
        [essay.id, person],
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]?.anchor_text).toBe('The Marshal');
      expect(rows[0]?.context).toContain('The Marshal presided.');
      // The snippet must not run back into the heading above it.
      expect(rows[0]?.context).not.toContain('Report');
      // With no display text the anchor falls back to the target's real title.
      expect(rows[1]?.anchor_text).toBe('Ion Antonescu');
    });

    it('rebuilds wholesale, so removing a reference removes its row', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const essay = await makeEssay(
        harness.pool,
        'Draft',
        'private',
        'A note about [[person:ion-antonescu]].',
      );
      expect(await countMentionsOf(harness.pool, person, admin)).toBe(1);

      const updated = await updateEssay(harness.pool, essay.id, {
        title: 'Draft',
        titleOriginal: '',
        language: '',
        summary: '',
        visibility: 'private',
        noindex: false,
        bodyMarkdown: 'A note about nobody in particular.',
        status: 'draft',
      });

      expect(updated).not.toBeNull();
      expect(await countMentionsOf(harness.pool, person, admin)).toBe(0);
    });

    it('records a citation separately from a mention and warns about a private source', async () => {
      const source = await makeSource(harness.pool, 'The Hooligan Year', 'private');
      const result = await makeEssay(
        harness.pool,
        'Citing Essay',
        'public',
        'As argued.[[cite:the-hooligan-year|45-47]]',
      );

      const citations = await queryRows<
        RowDataPacket & { source_item_id: number; locator: string | null }
      >(harness.pool, 'SELECT source_item_id, locator FROM citation WHERE citing_item_id = ?', [
        result.id,
      ]);
      expect(citations).toHaveLength(1);
      expect(citations[0]?.source_item_id).toBe(source);
      expect(citations[0]?.locator).toBe('45-47');

      // A citation is not a mention: it renders as a footnote, not a backlink.
      expect(await countMentionsOf(harness.pool, source, admin)).toBe(0);
    });

    it('reports an unresolved reference instead of inventing a row', async () => {
      const result = await makeEssay(
        harness.pool,
        'Forward Reference',
        'private',
        'About [[person:not-created-yet]].',
      );
      expect(result.unresolved).toEqual([{ kind: 'person', slug: 'not-created-yet' }]);
    });

    it('ignores a self-reference', async () => {
      const essay = await makeEssay(harness.pool, 'Self', 'private', 'Placeholder.');
      const rows = await queryRows<RowDataPacket & { total: number }>(
        harness.pool,
        'SELECT COUNT(*) AS total FROM mention WHERE from_item_id = ? AND to_item_id = ?',
        [essay.id, essay.id],
      );
      expect(Number(rows[0]?.total)).toBe(0);
    });

    it('records the paragraph each occurrence sits in', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Anchored',
        'private',
        [
          'Named in the first paragraph: [[person:ion-antonescu]].',
          '',
          '## A heading',
          '',
          'And again here: [[person:ion-antonescu|the Marshal]].',
        ].join('\n'),
      );

      const rows = await queryRows<RowDataPacket & { occurrence: number; block_index: number }>(
        harness.pool,
        `SELECT occurrence, block_index FROM mention
          WHERE to_item_id = ? ORDER BY occurrence ASC`,
        [person],
      );

      // The heading counts as a block, so the second mention is in the third.
      expect(rows.map((row) => Number(row.block_index))).toEqual([1, 3]);
    });

    it('anchors a backlink at the first occurrence', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Anchored Link',
        'public',
        'An opening.\n\nNamed here: [[person:ion-antonescu]].',
      );

      const [backlink] = await listMentionsOf(harness.pool, person, ANONYMOUS);
      // The quoted context and the paragraph the link opens are the same one.
      expect(backlink?.blockIndex).toBe(2);
      expect(backlink?.href).toBe('/essays/anchored-link#p2');
    });
  });

  describe('backlink visibility', () => {
    it('hides a private essay from a public person page entirely', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Unpublished Chapter',
        'private',
        'A confidential finding about [[person:ion-antonescu]].',
      );
      await makeEssay(
        harness.pool,
        'Published Report',
        'public',
        'A public note on [[person:ion-antonescu]].',
      );

      const anonymous = await listMentionsOf(harness.pool, person, ANONYMOUS);
      expect(anonymous).toHaveLength(1);
      expect(anonymous[0]?.title).toBe('Published Report');

      // Nothing about the private essay may appear anywhere in the result:
      // not the title, not the slug, not a sentence lifted from its body.
      const serialised = JSON.stringify(anonymous);
      expect(serialised).not.toContain('Unpublished');
      expect(serialised).not.toContain('unpublished-chapter');
      expect(serialised).not.toContain('confidential');

      expect(await countMentionsOf(harness.pool, person, ANONYMOUS)).toBe(1);
      expect(await countMentionsOf(harness.pool, person, admin)).toBe(2);
    });

    it('filters the outbound list too', async () => {
      const publicPerson = await makeEntity(harness.pool, 'person', 'Public Person', 'public');
      const privatePerson = await makeEntity(harness.pool, 'person', 'Private Person', 'private');
      const essay = await makeEssay(
        harness.pool,
        'Both',
        'public',
        'Concerning [[person:public-person]] and [[person:private-person]].',
      );

      const anonymous = await listMentionsFrom(harness.pool, essay.id, ANONYMOUS);
      expect(anonymous.map((entry) => entry.itemId)).toEqual([publicPerson]);
      expect(JSON.stringify(anonymous)).not.toContain('Private Person');

      const asAdmin = await listMentionsFrom(harness.pool, essay.id, admin);
      expect(asAdmin.map((entry) => entry.itemId).sort()).toEqual(
        [publicPerson, privatePerson].sort(),
      );
    });

    it('counts one backlink per citing item, however many times it names the target', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Repetitive',
        'public',
        '[[person:ion-antonescu]] and again [[person:ion-antonescu]] and [[person:ion-antonescu]].',
      );

      expect(await countMentionsOf(harness.pool, person, ANONYMOUS)).toBe(1);
      const backlinks = await listMentionsOf(harness.pool, person, ANONYMOUS);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0]?.occurrences).toBe(3);
    });
  });

  describe('referential integrity', () => {
    it('refuses to delete an entity whose prose references still stand', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const essay = await makeEssay(
        harness.pool,
        'Naming Essay',
        'private',
        'Concerning [[person:ion-antonescu]].',
      );

      // The blocking list is deliberately NOT visibility-filtered: a private
      // essay is exactly the one the operator would not think to look in.
      const blocking = await listReferencesBlockingDeletion(harness.pool, person);
      expect(blocking).toEqual([
        { kind: 'essay', slug: 'naming-essay', title: 'Naming Essay', relation: 'mention' },
      ]);

      // Refused before the foreign key would refuse it, so the operator gets a
      // list of what to edit rather than a constraint violation.
      expect(await deleteEntity(harness.pool, 'person', person)).toBe('referenced');

      // Remove the reference and the delete goes through.
      expect(await deleteEssay(harness.pool, essay.id)).toBe('deleted');
      expect(await deleteEntity(harness.pool, 'person', person)).toBe('deleted');
    });

    it('lists a citation as blocking a source deletion', async () => {
      const source = await makeSource(harness.pool, 'The Hooligan Year', 'public');
      await makeEssay(harness.pool, 'Citing', 'public', 'Argued.[[cite:the-hooligan-year|12]]');

      const blocking = await listReferencesBlockingDeletion(harness.pool, source);
      expect(blocking).toHaveLength(1);
      expect(blocking[0]?.relation).toBe('citation');
    });

    it('drops the projections an essay owned when the essay is deleted', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const essay = await makeEssay(
        harness.pool,
        'Temporary',
        'private',
        'On [[person:ion-antonescu]].',
      );

      expect(await deleteEssay(harness.pool, essay.id)).toBe('deleted');
      expect(await countMentionsOf(harness.pool, person, admin)).toBe(0);
    });
  });
});
