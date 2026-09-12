/**
 * A reference to something the reader may not see.
 *
 * One rule, in two places that had drifted from it: **a catalogue title is
 * never substituted for a reference the reader may not follow.** The prose
 * names a slug; the title is a different string the operator never wrote into
 * the sentence, and it can say considerably more than they did -- "Maria Doe
 * (informant, dosar 2231)" where the prose said only `[[person:maria-doe]]`.
 *
 * The two places, and why the fix differs:
 *
 *   - `renderProse` decides at read time and has a `Viewer`, so it asks about
 *     this reader.
 *   - `rebuildReferences` writes a stored snippet at save time and has no
 *     viewer and cannot have one -- the row is written once and read by
 *     everybody -- so it asks whether *anyone* may see the target.
 *
 * The stored half was the worse of the two: a public essay naming a private
 * person and a public one put the private person's title into the context
 * snippet shown on the **public** person's page, to anybody, and no read-time
 * check ever looked at it again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  databaseAvailable,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { createEssay, updateEssay, findEssayById } from '../../src/content/essays.js';
import { createEntity, setEntityVisibility } from '../../src/content/entities.js';
import { listMentionsOf, reprojectAll } from '../../src/content/mentions.js';
import { renderProse, WITHHELD_LABEL, type ReferenceTarget } from '../../src/content/markdown.js';
import { referenceKey } from '../../src/content/references.js';
import { resolveForRender } from '../../src/content/render-context.js';
import { adminViewer, ANONYMOUS, type Visibility } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('withheld references', () => {
  let harness: Harness;
  const admin = adminViewer(1);

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    await signIn(harness);
  });

  async function person(title: string, visibility: Visibility): Promise<number> {
    const { id } = await createEntity(harness.pool, 'person', {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      detail: {},
    });
    return id;
  }

  async function essay(body: string, visibility: Visibility = 'public'): Promise<number> {
    const { id } = await createEssay(harness.pool, {
      title: 'A public essay',
      titleOriginal: '',
      language: 'en',
      summary: '',
      visibility,
      noindex: false,
      bodyMarkdown: body,
      status: 'draft',
    });
    return id;
  }

  describe('the page', () => {
    // Unit-level, because the substitution happens in the renderer and the
    // fixture is what makes the case unambiguous.
    function target(overrides: Partial<ReferenceTarget> = {}): Map<string, ReferenceTarget> {
      const base: ReferenceTarget = {
        id: 2,
        kind: 'person',
        slug: 'maria-doe',
        title: 'Maria Doe (informant, dosar 2231)',
        visible: false,
        ...overrides,
      };
      return new Map([[referenceKey('person', base.slug), base]]);
    }

    it('never prints the catalogue title of a target the reader may not see', () => {
      const { html } = renderProse('He met [[person:maria-doe]] in Iasi.', {
        targets: target(),
        viewer: ANONYMOUS,
      });

      expect(html).not.toContain('Maria Doe');
      expect(html).not.toContain('dosar 2231');
      // Nor the slug, read as words or otherwise: invariant 2 rules out the
      // slug exactly as it rules out the title.
      expect(html).not.toContain('maria-doe');
      expect(html).not.toContain('maria doe');
      expect(html).toContain(WITHHELD_LABEL);
    });

    it('emits no link, id or title attribute for it', () => {
      const { html } = renderProse('He met [[person:maria-doe]] in Iasi.', {
        targets: target(),
        viewer: ANONYMOUS,
      });
      expect(html).not.toContain('href');
      expect(html).not.toContain('/people/');
    });

    it('keeps the words the prose itself used', () => {
      // The operator's own text, already on the page. What is withheld is the
      // catalogue record behind it, not their sentence.
      const { html } = renderProse('He met [[person:maria-doe|a neighbour]] in Iasi.', {
        targets: target(),
        viewer: ANONYMOUS,
      });
      expect(html).toContain('a neighbour');
      expect(html).not.toContain('Maria Doe');
      expect(html).not.toContain(WITHHELD_LABEL);
    });

    it('still shows the title and the link when the target is visible', () => {
      const { html } = renderProse('He met [[person:maria-doe]] in Iasi.', {
        targets: target({ visible: true, title: 'Maria Doe' }),
        viewer: ANONYMOUS,
      });
      expect(html).toContain('Maria Doe');
      expect(html).toContain('href="/people/maria-doe"');
    });

    it('still shows a broken reference as the operator typed it', () => {
      // Points at nothing, so there is no record to protect and the slug is
      // the operator's own typing -- the most useful thing to show them.
      const { html } = renderProse('He met [[person:no-such-person]] in Iasi.', {
        targets: new Map(),
        viewer: ANONYMOUS,
      });
      expect(html).toContain('no such person');
      expect(html).toContain('reference-broken');
    });

    it('shows the admin the title, since the target is visible to them', async () => {
      await person('Maria Doe', 'private');
      const body = 'He met [[person:maria-doe]] in Iasi.';
      const { html } = renderProse(body, {
        targets: await resolveForRender(harness.pool, body, admin),
        viewer: admin,
      });
      expect(html).toContain('Maria Doe');
    });
  });

  describe('the stored context snippet', () => {
    it('does not carry a private title onto a public page', async () => {
      // The exact shape of the leak: one public sentence naming a private
      // person and a public one. The backlink on the public person's page
      // quotes that sentence.
      await person('Maria Doe', 'private');
      const publicId = await person('Ion Antonescu', 'public');
      await essay('[[person:maria-doe]] met [[person:ion-antonescu]] at dawn.');

      const backlinks = await listMentionsOf(harness.pool, publicId, ANONYMOUS);
      expect(backlinks).toHaveLength(1);

      const context = backlinks[0]?.context ?? '';
      expect(context).toContain('Ion Antonescu');
      expect(context).not.toContain('Maria Doe');
      expect(context).not.toContain('maria-doe');
      expect(context).not.toContain('maria doe');
      expect(context).toContain(WITHHELD_LABEL);
    });

    it('keeps the display text the prose used, even for a private target', async () => {
      await person('Maria Doe', 'private');
      const publicId = await person('Ion Antonescu', 'public');
      await essay('[[person:maria-doe|a neighbour]] met [[person:ion-antonescu]] at dawn.');

      const context = (await listMentionsOf(harness.pool, publicId, ANONYMOUS))[0]?.context ?? '';
      expect(context).toContain('a neighbour');
      expect(context).not.toContain('Maria Doe');
    });

    it('carries a public title as before', async () => {
      const first = await person('Elena Vasiliu', 'public');
      await person('Ion Antonescu', 'public');
      await essay('[[person:ion-antonescu]] met [[person:elena-vasiliu]] at dawn.');

      const context = (await listMentionsOf(harness.pool, first, ANONYMOUS))[0]?.context ?? '';
      expect(context).toContain('Ion Antonescu');
      expect(context).toContain('Elena Vasiliu');
      expect(context).not.toContain(WITHHELD_LABEL);
    });

    it('still names the target itself in the anchor text', async () => {
      // Unlike the snippet, this names the row's own target, and the backlink
      // list carrying it is only rendered on that target's page -- which a
      // reader who may not see the target cannot open.
      const privateId = await person('Maria Doe', 'private');
      await essay('[[person:maria-doe]] met somebody at dawn.');

      const backlinks = await listMentionsOf(harness.pool, privateId, admin);
      expect(backlinks[0]?.anchorText).toBe('Maria Doe');
    });
  });

  describe('reprojection', () => {
    it('cleans a snippet written before the target was made private', async () => {
      // The staleness that makes a code-only fix insufficient: the snippet is
      // written once, and publishing or unpublishing is a plain UPDATE that
      // never revisits it.
      const mariaId = await person('Maria Doe', 'public');
      const publicId = await person('Ion Antonescu', 'public');
      await essay('[[person:maria-doe]] met [[person:ion-antonescu]] at dawn.');

      const before = (await listMentionsOf(harness.pool, publicId, ANONYMOUS))[0]?.context ?? '';
      expect(before).toContain('Maria Doe');

      await setEntityVisibility(harness.pool, 'person', mariaId, 'private');

      // Unchanged by the visibility change alone -- this is the leak that
      // would otherwise sit in the database untouched.
      const stale = (await listMentionsOf(harness.pool, publicId, ANONYMOUS))[0]?.context ?? '';
      expect(stale).toContain('Maria Doe');

      const summary = await reprojectAll(harness.pool);
      expect(summary.items).toBeGreaterThan(0);

      const after = (await listMentionsOf(harness.pool, publicId, ANONYMOUS))[0]?.context ?? '';
      expect(after).not.toContain('Maria Doe');
      expect(after).toContain(WITHHELD_LABEL);
      expect(after).toContain('Ion Antonescu');
    });

    it('is idempotent and changes nothing that is already correct', async () => {
      await person('Ion Antonescu', 'public');
      const essayId = await essay('[[person:ion-antonescu]] arrived at dawn.');

      const first = await reprojectAll(harness.pool);
      const second = await reprojectAll(harness.pool);
      expect(second).toEqual(first);

      // And the prose is untouched: this rebuilds the projection, never the
      // text it is derived from.
      const record = await findEssayById(harness.pool, essayId, admin);
      expect(record?.bodyMarkdown).toBe('[[person:ion-antonescu]] arrived at dawn.');
    });

    it('reaches every kind that holds prose, not only essays', async () => {
      await person('Ion Antonescu', 'public');
      await createEntity(harness.pool, 'person', {
        title: 'Elena Vasiliu',
        titleOriginal: '',
        language: '',
        summary: '',
        visibility: 'public',
        noindex: false,
        // A biography is prose whose references are projected like any other.
        detail: { biography: 'She met [[person:ion-antonescu]] in 1941.' },
      });

      const summary = await reprojectAll(harness.pool);
      // The biography's own mention survived a rebuild that started from
      // nothing but the prose.
      expect(summary.mentions).toBeGreaterThan(0);
    });

    it('leaves a later save as the newest state', async () => {
      const publicId = await person('Ion Antonescu', 'public');
      const essayId = await essay('[[person:ion-antonescu]] arrived at dawn.');

      await reprojectAll(harness.pool);
      await updateEssay(harness.pool, essayId, {
        title: 'A public essay',
        titleOriginal: '',
        language: 'en',
        summary: '',
        visibility: 'public',
        noindex: false,
        bodyMarkdown: '[[person:ion-antonescu]] left at dusk.',
        status: 'draft',
      });

      const context = (await listMentionsOf(harness.pool, publicId, ANONYMOUS))[0]?.context ?? '';
      expect(context).toContain('left at dusk');
    });
  });
});
