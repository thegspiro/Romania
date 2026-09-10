-- 0007_timeline (down)
--
-- Reverse order, and note what is lost: `event_detail.body_markdown` holds
-- prose, so rolling this back discards every event narrative that was written
-- against it -- the same kind of loss 0005's down documents for manuscripts.
-- The generated sort key, the two precisions and the paragraph anchors are
-- derived data and cost nothing to drop; `date_precision` survives untouched,
-- which is why the up-migration kept writing it.
--
-- No guard is needed here: a down only ever runs against a database whose up
-- ran to completion, and DROP COLUMN IF EXISTS is not needed for columns this
-- migration is known to have created.

-- The relationship rows first: relationship_predicate is referenced by a
-- RESTRICT foreign key, so an edge asserted with one of these verbs would
-- otherwise refuse the DELETE below.
--
-- Exactly the codes the up-migration seeded, and no others. 'commanded' looks
-- like it belongs here and does not: 0006_relationship_roles introduced it, so
-- removing it here would leave that migration applied and its vocabulary
-- half gone.
DELETE FROM relationship
 WHERE predicate_id IN (
   SELECT id FROM relationship_predicate
    WHERE code IN ('organized', 'attended', 'targeted',
                   'witnessed', 'caused', 'part_of')
 );

DELETE FROM relationship_predicate
 WHERE code IN ('organized', 'attended', 'targeted',
                'witnessed', 'caused', 'part_of');

ALTER TABLE mention
  DROP COLUMN block_index;

ALTER TABLE event_detail
  DROP KEY ix_event_detail_sort,
  DROP COLUMN sort_date,
  DROP COLUMN body_markdown,
  DROP COLUMN is_circa,
  DROP COLUMN end_precision,
  DROP COLUMN start_precision;
