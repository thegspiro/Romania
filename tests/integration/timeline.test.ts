/**
 * The chronology, against a real database.
 *
 * A timeline is a listing, which makes it the shape of thing that leaks: one
 * page carrying many items, so a missing filter discloses everything at once
 * rather than one thing. These tests pin the same three invariants
 * `visibility.test.ts` pins, restated for every new read this feature adds --
 * the page, the panels on entity and essay pages, the block embedded in prose,
 * and the compiled document.
 *
 * The place join gets its own tests because it is the one place a *public*
 * event can disclose a *private* item: an event held somewhere unpublished
 * must show no place at all, indistinguishable from an event with none.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  createHarness,
  databaseAvailable,
  getPage,
  postForm,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { makeEntity, makeEssay, makeManuscript } from './fixtures.js';
import { ANONYMOUS, adminViewer } from '../../src/content/visibility.js';
import {
  listEventsMentionedBy,
  listEventsRelatedTo,
  listTimeline,
} from '../../src/content/timeline.js';
import { createRelationship, listPredicates } from '../../src/content/relationships.js';
import { deleteEntity, findEntityById, updateEntity } from '../../src/content/entities.js';
import { listMentionsOf } from '../../src/content/mentions.js';
import { addSection, assembleDocument, findManuscriptById } from '../../src/content/manuscripts.js';
import { execute } from '../../src/db/pool.js';

const available = await databaseAvailable();

describe.skipIf(!available)('timeline', () => {
  let harness: Harness;
  let admin: Map<string, string>;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    admin = await signIn(harness);
  });

  /**
   * A request with no session at all.
   *
   * A fresh cookie jar each time, so nothing can leak between an anonymous
   * request and the signed-in one beside it -- which is the whole comparison
   * these tests are making.
   */
  async function anonymous(url: string): ReturnType<typeof getPage> {
    return getPage(harness, url, new Map<string, string>());
  }

  /** A dated event. Dates are ISO; precision says how much of them is meant. */
  async function makeEvent(
    title: string,
    visibility: 'public' | 'private',
    detail: Record<string, string> = {},
  ): Promise<number> {
    return makeEntity(harness.pool, 'event', title, visibility, {
      startPrecision: 'year',
      ...detail,
    });
  }

  async function predicateId(code: string): Promise<number> {
    const predicates = await listPredicates(harness.pool);
    const found = predicates.find((predicate) => predicate.code === code);
    if (found === undefined) throw new Error(`no predicate ${code}`);
    return found.id;
  }

  // --- The page ------------------------------------------------------------

  it('shows a public event and no trace of a private one', async () => {
    await makeEvent('The Iasi pogrom', 'public', { startDate: '1941-06-29' });
    await makeEvent('Unpublished incident', 'private', { startDate: '1942-03-01' });

    const page = await anonymous('/timeline');
    expect(page.body).toContain('The Iasi pogrom');
    // Not the title, and not the slug either: either one is the disclosure.
    expect(page.body).not.toContain('Unpublished incident');
    expect(page.body).not.toContain('unpublished-incident');
  });

  it('shows the administrator their private events, marked as such', async () => {
    await makeEvent('Unpublished incident', 'private', { startDate: '1942-03-01' });

    const page = await getPage(harness, '/timeline', admin);
    expect(page.body).toContain('Unpublished incident');
    expect(page.body).toContain('badge-private');
  });

  it('does not honour a visibility filter from an anonymous query string', async () => {
    await makeEvent('Unpublished incident', 'private', { startDate: '1942-03-01' });

    const page = await anonymous('/timeline?visibility=private');
    expect(page.body).not.toContain('Unpublished incident');
    expect(page.body).not.toContain('unpublished-incident');
  });

  it('applies the filter in the repository, not only in the route', async () => {
    await makeEvent('Public', 'public', { startDate: '1941-01-01' });
    await makeEvent('Private', 'private', { startDate: '1942-01-01' });

    // Defence in depth: the route is not the chokepoint.
    expect((await listTimeline(harness.pool, ANONYMOUS)).total).toBe(1);
    expect((await listTimeline(harness.pool, adminViewer(harness.userId))).total).toBe(2);
  });

  it('orders by date and puts undated events last', async () => {
    await makeEvent('Later', 'public', { startDate: '1944-01-01' });
    await makeEvent('Earlier', 'public', { startDate: '1940-01-01' });
    await makeEvent('Undated', 'public');

    const result = await listTimeline(harness.pool, ANONYMOUS);
    expect(result.items.map((entry) => entry.title)).toEqual(['Earlier', 'Later', 'Undated']);
  });

  it('renders a year-precision date as the year alone', async () => {
    await makeEvent('Somewhere in 1944', 'public', {
      startDate: '1944-01-01',
      startPrecision: 'year',
    });

    const page = await anonymous('/timeline');
    expect(page.body).toContain('1944');
    // The stored 01-01 is an artefact of the column type, not a claim.
    expect(page.body).not.toContain('1 January 1944');
  });

  it('filters by an overlapping date range', async () => {
    await makeEvent('Before', 'public', { startDate: '1935-01-01' });
    await makeEvent('Spanning', 'public', {
      startDate: '1939-01-01',
      endDate: '1945-01-01',
    });
    await makeEvent('After', 'public', { startDate: '1950-01-01' });

    const result = await listTimeline(harness.pool, ANONYMOUS, { from: '1941', to: '1943' });
    // An event running 1939-1945 belongs in a chronology of 1941-43 even
    // though neither endpoint falls inside it.
    expect(result.items.map((entry) => entry.title)).toEqual(['Spanning']);
  });

  // --- The place, which a public event must not disclose --------------------

  it('withholds a private place from a public event', async () => {
    const placeId = await makeEntity(harness.pool, 'place', 'Secret Location', 'private');
    const eventId = await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
    // The form resolves a place by slug and does not filter, deliberately --
    // the operator may attach a place they have not published yet. What must
    // not happen is that attaching it publishes it.
    await execute(
      harness.pool,
      'UPDATE event_detail SET place_item_id = ? WHERE content_item_id = ?',
      [placeId, eventId],
    );

    const listed = await listTimeline(harness.pool, ANONYMOUS);
    expect(listed.items).toHaveLength(1);
    // Absent, not redacted: no title, no slug, no id.
    expect(listed.items[0]?.place).toBeNull();

    const page = await anonymous('/events/a-public-event');
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('Secret Location');
    expect(page.body).not.toContain('secret-location');
    expect(page.body).not.toContain(`/places/${placeId}`);
  });

  it('shows a public place on a public event', async () => {
    const placeId = await makeEntity(harness.pool, 'place', 'Iasi', 'public');
    const eventId = await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
    await execute(
      harness.pool,
      'UPDATE event_detail SET place_item_id = ? WHERE content_item_id = ?',
      [placeId, eventId],
    );

    const page = await anonymous('/events/a-public-event');
    expect(page.body).toContain('Iasi');
    expect(page.body).toContain('/places/iasi');
  });

  // --- Connections ---------------------------------------------------------

  it('lists a connected event on a person page', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    const eventId = await makeEvent('A public event', 'public', { startDate: '1941-01-01' });

    const created = await createRelationship(harness.pool, {
      fromItemId: personId,
      toItemId: eventId,
      predicateId: await predicateId('participated_in'),
      note: null,
      visibility: 'public',
    });
    expect(created.ok).toBe(true);

    const chronology = await listEventsRelatedTo(harness.pool, personId, ANONYMOUS);
    expect(chronology.map((entry) => entry.title)).toEqual(['A public event']);

    const page = await anonymous('/people/ion-antonescu');
    expect(page.body).toContain('A public event');
  });

  it('does not reach an event through a private edge', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    const eventId = await makeEvent('A public event', 'public', { startDate: '1941-01-01' });

    await createRelationship(harness.pool, {
      fromItemId: personId,
      toItemId: eventId,
      predicateId: await predicateId('participated_in'),
      note: null,
      // The relationship between two published things can itself be the
      // sensitive part.
      visibility: 'private',
    });

    expect(await listEventsRelatedTo(harness.pool, personId, ANONYMOUS)).toEqual([]);
    expect(
      (await listEventsRelatedTo(harness.pool, personId, adminViewer(harness.userId))).map(
        (entry) => entry.title,
      ),
    ).toEqual(['A public event']);
  });

  it('does not reach a private event through a public edge', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    const eventId = await makeEvent('Unpublished incident', 'private', {
      startDate: '1941-01-01',
    });

    await createRelationship(harness.pool, {
      fromItemId: personId,
      toItemId: eventId,
      predicateId: await predicateId('participated_in'),
      note: null,
      visibility: 'public',
    });

    expect(await listEventsRelatedTo(harness.pool, personId, ANONYMOUS)).toEqual([]);

    const page = await anonymous('/people/ion-antonescu');
    expect(page.body).not.toContain('Unpublished incident');
    expect(page.body).not.toContain('unpublished-incident');
  });

  it('seeds the event-shaped predicates', async () => {
    const codes = (await listPredicates(harness.pool)).map((predicate) => predicate.code);
    for (const code of ['organized', 'attended', 'commanded', 'targeted', 'witnessed']) {
      expect(codes).toContain(code);
    }
  });

  // --- Prose ---------------------------------------------------------------

  it('lists the events an essay names, in date order', async () => {
    await makeEvent('Later', 'public', { startDate: '1944-01-01' });
    await makeEvent('Earlier', 'public', { startDate: '1940-01-01' });

    const essay = await makeEssay(
      harness.pool,
      'An essay',
      'public',
      'It began at [[event:later]] but really at [[event:earlier]].',
    );

    const chronology = await listEventsMentionedBy(harness.pool, essay.id, ANONYMOUS);
    expect(chronology.map((entry) => entry.title)).toEqual(['Earlier', 'Later']);
  });

  it('keeps a private essay off a public event page', async () => {
    await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
    await makeEssay(
      harness.pool,
      'Unpublished essay',
      'private',
      'Concerning [[event:a-public-event]].',
    );

    const page = await anonymous('/events/a-public-event');
    expect(page.body).not.toContain('Unpublished essay');
    expect(page.body).not.toContain('unpublished-essay');
  });

  it('points a backlink at the paragraph that named the event', async () => {
    const eventId = await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
    await makeEssay(
      harness.pool,
      'An essay',
      'public',
      'An opening paragraph.\n\nA second one.\n\nAnd then [[event:a-public-event]] happened.',
    );

    const [backlink] = await listMentionsOf(harness.pool, eventId, ANONYMOUS);
    expect(backlink?.blockIndex).toBe(3);
    expect(backlink?.href).toBe('/essays/an-essay#p3');

    // The anchor has to address a paragraph the rendered page actually has.
    const essayPage = await anonymous('/essays/an-essay');
    expect(essayPage.body).toContain('id="p3"');
  });

  it('renders a timeline block, and never a private event in one', async () => {
    await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
    await makeEvent('Unpublished incident', 'private', { startDate: '1942-01-01' });

    await makeEssay(
      harness.pool,
      'An essay',
      'public',
      ['Before.', '', '```timeline', 'from: 1940', 'to: 1945', '```', '', 'After.'].join('\n'),
    );

    const page = await anonymous('/essays/an-essay');
    expect(page.body).toContain('A public event');
    // No gap and no placeholder where the private one would have been.
    expect(page.body).not.toContain('Unpublished incident');
    expect(page.body).not.toContain('unpublished-incident');
    expect(page.body).not.toContain('Reference withheld');

    const adminPage = await getPage(harness, '/essays/an-essay', admin);
    expect(adminPage.body).toContain('Unpublished incident');
  });

  it('scopes a timeline block to its subject', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    const eventId = await makeEvent('Connected', 'public', { startDate: '1941-01-01' });
    await makeEvent('Unconnected', 'public', { startDate: '1942-01-01' });

    await createRelationship(harness.pool, {
      fromItemId: personId,
      toItemId: eventId,
      predicateId: await predicateId('participated_in'),
      note: null,
      visibility: 'public',
    });

    await makeEssay(
      harness.pool,
      'An essay',
      'public',
      ['```timeline', 'about: person:ion-antonescu', '```'].join('\n'),
    );

    const page = await anonymous('/essays/an-essay');
    expect(page.body).toContain('Connected');
    expect(page.body).not.toContain('Unconnected');
  });

  // --- An event's own prose ------------------------------------------------

  it('indexes references in an event narrative', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    await makeEvent('A public event', 'public', {
      startDate: '1941-01-01',
      bodyMarkdown: 'Ordered by [[person:ion-antonescu]].',
    });

    const backlinks = await listMentionsOf(harness.pool, personId, ANONYMOUS);
    expect(backlinks.map((entry) => entry.title)).toEqual(['A public event']);

    // And the narrative renders with the reference as a link.
    const page = await anonymous('/events/a-public-event');
    expect(page.body).toContain('/people/ion-antonescu');
  });

  it('refuses to delete a person an event narrative still names', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    await makeEvent('A public event', 'public', {
      bodyMarkdown: 'Ordered by [[person:ion-antonescu]].',
    });

    expect(await deleteEntity(harness.pool, 'person', personId)).toBe('referenced');
  });

  it('rebuilds the projection when the narrative changes', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    const eventId = await makeEvent('A public event', 'public', {
      bodyMarkdown: 'Ordered by [[person:ion-antonescu]].',
    });

    expect(await listMentionsOf(harness.pool, personId, ANONYMOUS)).toHaveLength(1);

    const record = await findEntityById(
      harness.pool,
      'event',
      eventId,
      adminViewer(harness.userId),
    );
    expect(record).not.toBeNull();

    await updateEntity(harness.pool, 'event', eventId, {
      title: record!.title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility: 'public',
      noindex: false,
      detail: { bodyMarkdown: 'The name has been removed.' },
    });

    // Wholesale rebuild, not a diff: the prose is the only source.
    expect(await listMentionsOf(harness.pool, personId, ANONYMOUS)).toHaveLength(0);
  });

  it('keeps the narrative of a private event off a public person page', async () => {
    const personId = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
    await makeEvent('Unpublished incident', 'private', {
      bodyMarkdown: 'Ordered by [[person:ion-antonescu]].',
    });

    const page = await anonymous('/people/ion-antonescu');
    expect(page.body).not.toContain('Unpublished incident');
    expect(page.body).not.toContain('unpublished-incident');
    expect(personId).toBeGreaterThan(0);
  });

  // --- The admin form ------------------------------------------------------

  it('offers the date, place and narrative fields on the event form', async () => {
    // Template errors surface only at render time, and these fields are the
    // only way the new columns are ever filled in.
    const page = await getPage(harness, '/admin/events/new', admin);
    expect(page.statusCode).toBe(200);
    for (const field of [
      'startPrecision',
      'endPrecision',
      'isCirca',
      'placeSlug',
      'bodyMarkdown',
    ]) {
      expect(page.body, field).toContain(`name="${field}"`);
    }
    // The prose editor comes with the reference picker, so an account can name
    // a person without the operator typing the syntax.
    expect(page.body).toContain('data-editor="bodyMarkdown"');
    expect(page.body).toContain('id="reference-search"');
  });

  it('offers the same editor on the person form', async () => {
    const page = await getPage(harness, '/admin/people/new', admin);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-editor="biography"');
  });

  it('round-trips the new event fields through the form', async () => {
    const page = await getPage(harness, '/admin/events/new', admin);
    const created = await postForm(harness, '/admin/events', admin, {
      _csrf: page.csrf,
      title: 'A dated event',
      titleOriginal: '',
      language: '',
      summary: '',
      startDate: '1943-06-01',
      startPrecision: 'month',
      endDate: '1945-01-01',
      endPrecision: 'year',
      isCirca: 'on',
      placeSlug: '',
      bodyMarkdown: 'An account.',
      visibility: 'public',
    });

    const id = Number(/\/admin\/events\/(\d+)\/edit/.exec(created.location ?? '')?.[1]);
    expect(Number.isSafeInteger(id)).toBe(true);

    const record = await findEntityById(harness.pool, 'event', id, adminViewer(harness.userId));
    expect(record?.detail.startPrecision).toBe('month');
    expect(record?.detail.endPrecision).toBe('year');
    expect(record?.detail.isCirca).toBe(1);
    expect(record?.detail.bodyMarkdown).toBe('An account.');
    // The legacy column keeps tracking the start, which is what makes
    // migration 0007's backfill safe to run again.
    expect(record?.detail.datePrecision).toBe('month');

    const publicPage = await anonymous('/events/a-dated-event');
    expect(publicPage.body).toContain('c. June 1943 – 1945');
  });

  it('keeps an event date through a load-and-resave of the edit form', async () => {
    // The regression this guards: a DATE column read back as a JS Date turns
    // into "Tue Jun 01" in the form field, which `isoDate` then rejects -- so
    // opening an event and pressing Save silently erased its date. The dates
    // are the record for an event, so that is data loss, not cosmetics.
    const newForm = await getPage(harness, '/admin/events/new', admin);
    const created = await postForm(harness, '/admin/events', admin, {
      _csrf: newForm.csrf,
      title: 'A dated event',
      titleOriginal: '',
      language: '',
      summary: '',
      startDate: '1943-06-01',
      startPrecision: 'month',
      endDate: '',
      endPrecision: '',
      placeSlug: '',
      bodyMarkdown: '',
      visibility: 'public',
    });
    const id = Number(/\/admin\/events\/(\d+)\/edit/.exec(created.location ?? '')?.[1]);

    const editForm = await getPage(harness, `/admin/events/${id}/edit`, admin);
    // The field holds an ISO date, which is what the form promises and what
    // the parser accepts.
    expect(editForm.body).toContain('value="1943-06-01"');

    await postForm(harness, `/admin/events/${id}`, admin, {
      _csrf: editForm.csrf,
      title: 'A dated event',
      titleOriginal: '',
      language: '',
      summary: '',
      startDate: '1943-06-01',
      startPrecision: 'month',
      endDate: '',
      endPrecision: '',
      placeSlug: '',
      bodyMarkdown: '',
      visibility: 'public',
    });

    const record = await findEntityById(harness.pool, 'event', id, adminViewer(harness.userId));
    expect(record?.detail.startDate).toBe('1943-06-01');
  });

  // --- Compilation ---------------------------------------------------------

  it('assembles a public build with no private event in its timeline block', async () => {
    await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
    await makeEvent('Unpublished incident', 'private', { startDate: '1942-01-01' });

    const essay = await makeEssay(
      harness.pool,
      'A chapter',
      'public',
      ['Text.', '', '```timeline', 'from: 1940', 'to: 1945', '```'].join('\n'),
    );

    const manuscriptId = await makeManuscript(harness.pool, 'A manuscript', 'public');
    await addSection(harness.pool, manuscriptId, essay.id, {});

    const manuscript = await findManuscriptById(
      harness.pool,
      manuscriptId,
      adminViewer(harness.userId),
    );
    expect(manuscript).not.toBeNull();

    // A public build is assembled with an anonymous viewer. This is the one
    // artefact where a mistake would leak everything at once.
    const publicBuild = await assembleDocument(harness.pool, manuscript!, ANONYMOUS);
    expect(publicBuild.markdown).toContain('A public event');
    expect(publicBuild.markdown).not.toContain('Unpublished incident');
    // The fence itself is gone: Pandoc receives ordinary Markdown, and the
    // worker never learns this syntax exists.
    expect(publicBuild.markdown).not.toContain('```timeline');

    const adminBuild = await assembleDocument(
      harness.pool,
      manuscript!,
      adminViewer(harness.userId),
    );
    expect(adminBuild.markdown).toContain('Unpublished incident');
  });
});
