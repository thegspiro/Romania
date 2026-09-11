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
  findEventBoundSlugs,
  findTimelineEntry,
  listEventsAround,
  listEventsMentionedBy,
  listEventsRelatedTo,
  listTimeline,
  parseTimelineDirective,
  resolveTimelineDirectives,
  setEventBounds,
  sortEntries,
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

  // --- Time of day ---------------------------------------------------------

  it('records and renders a time when the precision claims one', async () => {
    await makeEvent('An order signed', 'public', {
      startDate: '1943-06-02',
      startTime: '14:30',
      startPrecision: 'minute',
    });

    const page = await anonymous('/events/an-order-signed');
    expect(page.body).toContain('2 June 1943, 14:30');
  });

  it('does not show a stored time below hour precision', async () => {
    await makeEvent('A day-long affair', 'public', {
      startDate: '1943-06-02',
      startTime: '14:30',
      startPrecision: 'day',
    });

    const page = await anonymous('/events/a-day-long-affair');
    expect(page.body).toContain('2 June 1943');
    expect(page.body).not.toContain('14:30');
  });

  it('orders two events on the same day by the clock', async () => {
    await makeEvent('The afternoon meeting', 'public', {
      startDate: '1943-06-02',
      startTime: '17:00',
      startPrecision: 'minute',
    });
    await makeEvent('The morning meeting', 'public', {
      startDate: '1943-06-02',
      startTime: '09:00',
      startPrecision: 'minute',
    });

    const result = await listTimeline(harness.pool, ANONYMOUS);
    expect(result.items.map((entry) => entry.title)).toEqual([
      'The morning meeting',
      'The afternoon meeting',
    ]);
  });

  // --- Relative dating -----------------------------------------------------

  /** Records "event happens after `after`, and before `before`". */
  async function bound(
    eventId: number,
    anchors: { after?: string[]; before?: string[] },
    visibility: 'public' | 'private' = 'public',
  ): Promise<void> {
    await setEventBounds(harness.pool, eventId, {
      afterSlugs: anchors.after ?? [],
      beforeSlugs: anchors.before ?? [],
      visibility,
    });
  }

  it('places an undated event between the events that bound it', async () => {
    await makeEvent('The pogrom', 'public', { startDate: '1941-06-29' });
    await makeEvent('The armistice', 'public', { startDate: '1944-08-23' });
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['the-pogrom'], before: ['the-armistice'] });

    const result = await listTimeline(harness.pool, ANONYMOUS);
    // Sorted into the chronology at the start of its window, not dumped at
    // the end with the genuinely unplaceable.
    expect(result.items.map((entry) => entry.title)).toEqual([
      'The pogrom',
      'A contested killing',
      'The armistice',
    ]);

    const entry = result.items[1];
    expect(entry?.dateLabel).toBe('after The pogrom, before The armistice');
    expect(entry?.bounds?.earliest).toBe('1941-06-29');
    expect(entry?.bounds?.latest).toBe('1944-08-23');
  });

  it('draws a bounded event as an uncertainty span', async () => {
    await makeEvent('The pogrom', 'public', { startDate: '1941-06-29' });
    await makeEvent('The armistice', 'public', { startDate: '1944-08-23' });
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['the-pogrom'], before: ['the-armistice'] });

    const page = await anonymous('/timeline');
    expect(page.body).toContain('band-span-uncertain');
    expect(page.body).toContain('after The pogrom, before The armistice');
  });

  it('shows the bounds on the event page', async () => {
    await makeEvent('The pogrom', 'public', { startDate: '1941-06-29' });
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['the-pogrom'] });

    const page = await anonymous('/events/a-contested-killing');
    expect(page.body).toContain('The pogrom');
    expect(page.body).toContain('/events/the-pogrom');
  });

  it('does not let a private anchor place a public event', async () => {
    // The disclosure this guards: if the window were computed and *then*
    // filtered, a public event would sit at a private event's date on the
    // band, which gives that date away without ever naming it.
    await makeEvent('Unpublished incident', 'private', { startDate: '1941-06-29' });
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['unpublished-incident'] });

    const anonymousResult = await listTimeline(harness.pool, ANONYMOUS);
    const entry = anonymousResult.items.find((item) => item.title === 'A contested killing');
    expect(entry?.bounds).toBeNull();
    expect(entry?.dateLabel).toBe('Undated');

    const page = await anonymous('/timeline');
    expect(page.body).not.toContain('Unpublished incident');
    expect(page.body).not.toContain('unpublished-incident');
    expect(page.body).not.toContain('1941');

    // The administrator sees the bound and the position it implies.
    const asAdmin = await listTimeline(harness.pool, adminViewer(harness.userId));
    const adminEntry = asAdmin.items.find((item) => item.title === 'A contested killing');
    expect(adminEntry?.bounds?.earliest).toBe('1941-06-29');
  });

  it('does not let a private bound place a public event', async () => {
    await makeEvent('The pogrom', 'public', { startDate: '1941-06-29' });
    const contested = await makeEvent('A contested killing', 'public');
    // Both events published, the claim connecting them not.
    await bound(contested, { after: ['the-pogrom'] }, 'private');

    const result = await listTimeline(harness.pool, ANONYMOUS);
    const entry = result.items.find((item) => item.title === 'A contested killing');
    expect(entry?.bounds).toBeNull();

    const asAdmin = await listTimeline(harness.pool, adminViewer(harness.userId));
    const adminEntry = asAdmin.items.find((item) => item.title === 'A contested killing');
    expect(adminEntry?.bounds?.earliest).toBe('1941-06-29');
  });

  it('ignores an anchor that is itself undated rather than chasing a chain', async () => {
    await makeEvent('Also undated', 'public');
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['also-undated'] });

    const result = await listTimeline(harness.pool, ANONYMOUS);
    const entry = result.items.find((item) => item.title === 'A contested killing');
    // The anchor is named, because that is a real claim about ordering; the
    // window is empty, because nothing dates it.
    expect(entry?.bounds?.earliest).toBeNull();
    expect(entry?.dateLabel).toBe('after Also undated');
  });

  it('takes the tightest window when several anchors bound one event', async () => {
    await makeEvent('Early', 'public', { startDate: '1940-01-01' });
    await makeEvent('Later', 'public', { startDate: '1942-01-01' });
    await makeEvent('Latest', 'public', { startDate: '1945-01-01' });
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['early', 'later'], before: ['latest'] });

    const result = await listTimeline(harness.pool, ANONYMOUS);
    const entry = result.items.find((item) => item.title === 'A contested killing');
    // The latest lower bound and the earliest upper bound are the ones that
    // actually narrow it, and the label names them.
    expect(entry?.bounds?.earliest).toBe('1942-01-01');
    expect(entry?.bounds?.latest).toBe('1945-01-01');
    expect(entry?.dateLabel).toBe('after Later, before Latest');
  });

  it('replaces bounds wholesale rather than accumulating them', async () => {
    await makeEvent('The pogrom', 'public', { startDate: '1941-06-29' });
    await makeEvent('The armistice', 'public', { startDate: '1944-08-23' });
    const contested = await makeEvent('A contested killing', 'public');

    await bound(contested, { after: ['the-pogrom'] });
    await bound(contested, { after: ['the-armistice'] });

    const stored = await findEventBoundSlugs(harness.pool, contested);
    expect(stored.afterSlugs).toEqual(['the-armistice']);
    expect(stored.beforeSlugs).toEqual([]);
  });

  it('reports a slug that names no event instead of failing the save', async () => {
    const contested = await makeEvent('A contested killing', 'public');
    const result = await setEventBounds(harness.pool, contested, {
      afterSlugs: ['no-such-event'],
      beforeSlugs: [],
      visibility: 'public',
    });
    expect(result.unresolved).toEqual(['no-such-event']);
  });

  it('refuses to bound an event against itself', async () => {
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['a-contested-killing'] });
    expect((await findEventBoundSlugs(harness.pool, contested)).afterSlugs).toEqual([]);
  });

  // --- Defects #5 shipped ---------------------------------------------------

  it('keeps a bounded event in a date range covering its window', async () => {
    // The regression: the page places this event and the band draws it, and
    // then a date filter over the very range it is known to fall in made it
    // vanish -- because the filter read the event's own columns, which are
    // empty, instead of the window its bounds allow.
    await makeEvent('The pogrom', 'public', { startDate: '1941-06-29' });
    await makeEvent('The armistice', 'public', { startDate: '1944-08-23' });
    const contested = await makeEvent('A contested killing', 'public');
    await bound(contested, { after: ['the-pogrom'], before: ['the-armistice'] });

    const covering = await listTimeline(harness.pool, ANONYMOUS, { from: '1942', to: '1943' });
    expect(covering.items.map((entry) => entry.title)).toContain('A contested killing');

    const before = await listTimeline(harness.pool, ANONYMOUS, { from: '1930', to: '1935' });
    expect(before.items.map((entry) => entry.title)).not.toContain('A contested killing');

    const after = await listTimeline(harness.pool, ANONYMOUS, { from: '1950', to: '1955' });
    expect(after.items.map((entry) => entry.title)).not.toContain('A contested killing');
  });

  it('keeps every filter on a paging link', async () => {
    // Enough events to page, all in range, so the link is rendered.
    for (let index = 0; index < 60; index += 1) {
      await makeEvent(`Event ${String(index).padStart(3, '0')}`, 'public', {
        startDate: '1941-06-29',
      });
    }

    const page = await anonymous('/timeline?from=1940&to=1944&place=&q=Event');
    // Previously this read `/timeline?page=2` and dropped from/to/q entirely.
    expect(page.body).toContain('page=2');
    expect(page.body).toContain('from=1940');
    expect(page.body).toContain('to=1944');
    expect(page.body).toContain('q=Event');
  });

  it('merges several subjects into one correct chronology', async () => {
    // A regression guard for the refactor that made this one query instead of
    // one per subject. NOT a bug fix: the old per-subject limit was lossless,
    // because taking each subject's earliest N and merging still contains the
    // global earliest N. What changed is the cost, and that duplicate subjects
    // are now collapsed rather than queried twice.
    const first = await makeEntity(harness.pool, 'person', 'First Subject', 'public');
    const second = await makeEntity(harness.pool, 'person', 'Second Subject', 'public');
    const participated = await predicateId('participated_in');

    // Three events each. The earliest three overall belong to `second`, so a
    // per-subject limit of 3 applied before the merge would wrongly keep
    // `first`'s later events.
    const connect = async (personId: number, titles: string[], year: number): Promise<void> => {
      for (const [index, title] of titles.entries()) {
        const eventId = await makeEvent(title, 'public', {
          startDate: `${year + index}-01-01`,
        });
        await createRelationship(harness.pool, {
          fromItemId: personId,
          toItemId: eventId,
          predicateId: participated,
          note: null,
          visibility: 'public',
        });
      }
    };

    await connect(first, ['Late A', 'Late B', 'Late C'], 1950);
    await connect(second, ['Early A', 'Early B', 'Early C'], 1930);

    const resolved = await resolveTimelineDirectives(
      harness.pool,
      [parseTimelineDirective('about: person:first-subject, person:second-subject\nlimit: 3')],
      ANONYMOUS,
    );

    const [entries] = [...resolved.values()];
    expect(entries?.map((entry) => entry.title)).toEqual(['Early A', 'Early B', 'Early C']);

    // The same subject named twice contributes its events once.
    const repeated = await resolveTimelineDirectives(
      harness.pool,
      [parseTimelineDirective('about: person:second-subject, person:second-subject')],
      ANONYMOUS,
    );
    const [repeatedEntries] = [...repeated.values()];
    expect(repeatedEntries?.map((entry) => entry.title)).toEqual(['Early A', 'Early B', 'Early C']);
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
  // --- Around this time -----------------------------------------------------

  describe('around this time', () => {
    /** The entry as an anonymous reader sees it, which is what the panel takes. */
    async function entryFor(slug: string) {
      const found = await findTimelineEntry(harness.pool, slug, ANONYMOUS);
      if (found === null) throw new Error(`no event ${slug}`);
      return found;
    }

    it('surveys the month around a day-precision event', async () => {
      await makeEvent('The pogrom', 'public', {
        startDate: '1941-06-29',
        startPrecision: 'day',
      });
      await makeEvent('A raid the same month', 'public', {
        startDate: '1941-06-15',
        startPrecision: 'day',
      });
      await makeEvent('Something the next year', 'public', {
        startDate: '1942-06-15',
        startPrecision: 'day',
      });

      const around = await listEventsAround(harness.pool, await entryFor('the-pogrom'), ANONYMOUS);
      expect(around.map((item) => item.slug)).toEqual(['a-raid-the-same-month']);
    });

    it('surveys the decade around a year-precision one', async () => {
      // The question scales with how well the event is known.
      await makeEvent('A year-precision event', 'public', { startDate: '1941-01-01' });
      await makeEvent('Later in the decade', 'public', { startDate: '1945-01-01' });
      await makeEvent('The next decade', 'public', { startDate: '1955-01-01' });

      const around = await listEventsAround(
        harness.pool,
        await entryFor('a-year-precision-event'),
        ANONYMOUS,
      );
      expect(around.map((item) => item.slug)).toEqual(['later-in-the-decade']);
    });

    it('never lists an event among its own neighbours', async () => {
      await makeEvent('The pogrom', 'public', { startDate: '1941-06-29', startPrecision: 'day' });

      const around = await listEventsAround(harness.pool, await entryFor('the-pogrom'), ANONYMOUS);
      expect(around.map((item) => item.slug)).not.toContain('the-pogrom');
    });

    it('omits a private neighbour entirely', async () => {
      await makeEvent('The pogrom', 'public', { startDate: '1941-06-29', startPrecision: 'day' });
      await makeEvent('Unpublished incident', 'private', {
        startDate: '1941-06-15',
        startPrecision: 'day',
      });

      const around = await listEventsAround(harness.pool, await entryFor('the-pogrom'), ANONYMOUS);
      // No gap and no placeholder: indistinguishable from never having existed.
      expect(around).toHaveLength(0);

      const page = await anonymous('/events/the-pogrom');
      expect(page.body).not.toContain('Unpublished incident');
      expect(page.body).not.toContain('unpublished-incident');

      const asAdmin = await getPage(harness, '/events/the-pogrom', admin);
      expect(asAdmin.body).toContain('Around this time');
      expect(asAdmin.body).toContain('Unpublished incident');
    });

    it('offers nothing for an event nothing places', async () => {
      await makeEvent('An undated event', 'public', { startPrecision: 'unknown' });

      const around = await listEventsAround(
        harness.pool,
        await entryFor('an-undated-event'),
        ANONYMOUS,
      );
      expect(around).toHaveLength(0);
    });

    it('shows the panel on the event page', async () => {
      await makeEvent('The pogrom', 'public', { startDate: '1941-06-29', startPrecision: 'day' });
      await makeEvent('A raid the same month', 'public', {
        startDate: '1941-06-15',
        startPrecision: 'day',
      });

      const page = await anonymous('/events/the-pogrom');
      expect(page.body).toContain('Around this time');
      expect(page.body).toContain('A raid the same month');
    });
  });

  // --- Taking a chronology away ---------------------------------------------

  describe('export', () => {
    async function download(
      url: string,
      jar?: Map<string, string>,
    ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
      const page = await getPage(harness, url, jar ?? new Map<string, string>());
      const response = await harness.app.inject({ method: 'GET', url });
      return {
        statusCode: page.statusCode,
        body: page.body,
        headers: response.headers as Record<string, string>,
      };
    }

    it('carries a public event and no trace of a private one', async () => {
      await makeEvent('The Iasi pogrom', 'public', { startDate: '1941-06-29' });
      await makeEvent('Unpublished incident', 'private', { startDate: '1942-03-01' });

      for (const url of ['/timeline.csv', '/timeline.ics']) {
        const file = await download(url);
        expect(file.statusCode).toBe(200);
        expect(file.body).toContain('The Iasi pogrom');
        // Not the title, and not the slug either: either one is the disclosure.
        expect(file.body).not.toContain('Unpublished incident');
        expect(file.body).not.toContain('unpublished-incident');
      }
    });

    it('carries both for the administrator', async () => {
      await makeEvent('Unpublished incident', 'private', { startDate: '1942-03-01' });

      const csv = await getPage(harness, '/timeline.csv', admin);
      expect(csv.body).toContain('Unpublished incident');
      const ics = await getPage(harness, '/timeline.ics', admin);
      expect(ics.body).toContain('Unpublished incident');
    });

    it('refuses a visibility filter from the query string', async () => {
      // The export honours exactly what the page honours, which means it
      // refuses exactly what the page refuses.
      await makeEvent('Unpublished incident', 'private', { startDate: '1942-03-01' });

      const file = await download('/timeline.csv?visibility=private');
      expect(file.body).not.toContain('Unpublished incident');
      expect(file.body).not.toContain('unpublished-incident');
    });

    it('withholds a private place from a public event', async () => {
      const placeId = await makeEntity(harness.pool, 'place', 'Secret Location', 'private');
      const eventId = await makeEvent('A public event', 'public', { startDate: '1941-01-01' });
      await execute(
        harness.pool,
        'UPDATE event_detail SET place_item_id = ? WHERE content_item_id = ?',
        [placeId, eventId],
      );

      for (const url of ['/timeline.csv', '/timeline.ics']) {
        const file = await download(url);
        expect(file.body).toContain('A public event');
        expect(file.body).not.toContain('Secret Location');
        expect(file.body).not.toContain('secret-location');
      }
    });

    it('honours the same date filters the page does', async () => {
      await makeEvent('In range', 'public', { startDate: '1943-01-01' });
      await makeEvent('Out of range', 'public', { startDate: '1950-01-01' });

      const file = await download('/timeline.csv?from=1943&to=1943');
      expect(file.body).toContain('In range');
      expect(file.body).not.toContain('Out of range');
    });

    it('is served as a download that no cache may keep', async () => {
      await makeEvent('The Iasi pogrom', 'public', { startDate: '1941-06-29' });

      const csv = await download('/timeline.csv');
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('attachment');
      // A chronology an administrator exported may hold unpublished material.
      expect(csv.headers['cache-control']).toContain('no-store');
      expect(csv.headers['x-robots-tag']).toContain('noindex');

      const ics = await download('/timeline.ics');
      expect(ics.headers['content-type']).toContain('text/calendar');
      expect(ics.body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    });
  });

  // --- Two implementations of one ordering ----------------------------------

  it('orders rows the same way in SQL and in TypeScript', async () => {
    // `CHRONOLOGICAL_ORDER` and `sortEntries` are one spec written twice, and
    // they had already drifted: the SQL `FIELD(...)` list omitted 'unknown',
    // which FIELD scores 0 -- first -- while `sortEntries` ranks it last.
    await makeEvent('Decade', 'public', { startDate: '1940-01-01', startPrecision: 'decade' });
    await makeEvent('Year', 'public', { startDate: '1940-01-01' });
    await makeEvent('Month', 'public', { startDate: '1940-01-01', startPrecision: 'month' });
    await makeEvent('Unstated', 'public', { startDate: '1940-01-01', startPrecision: 'unknown' });
    await makeEvent('Morning', 'public', {
      startDate: '1940-01-01',
      startTime: '09:00',
      startPrecision: 'minute',
    });
    await makeEvent('Evening', 'public', {
      startDate: '1940-01-01',
      startTime: '17:00',
      startPrecision: 'minute',
    });
    await makeEvent('Later', 'public', { startDate: '1944-01-01' });
    await makeEvent('Undated', 'public', { startPrecision: 'unknown' });

    const viewer = adminViewer(harness.userId);
    const listed = await listTimeline(harness.pool, viewer, { limit: 200 });
    expect(listed.items.length).toBeGreaterThan(5);

    // The database's order must already be a fixed point of the TypeScript one.
    expect(sortEntries(listed.items).map((item) => item.id)).toEqual(
      listed.items.map((item) => item.id),
    );
  });
});
