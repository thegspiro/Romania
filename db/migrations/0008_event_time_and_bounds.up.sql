-- 0008_event_time_and_bounds (up)
--
-- Two things the sources force on a chronology.
--
-- **A time of day, sometimes.** An order signed at 14:30 and a war that ran
-- for six years are both events, and the schema has to hold either without
-- inventing a precision for the other. So the time is nullable and the
-- existing precision ladder is extended rather than duplicated: the stored
-- value is read only as far as the precision claims, exactly as 1944-01-01 at
-- 'year' means "1944". At 'hour', 14:00 means "the 14:00 hour", not "on the
-- hour"; at 'day' or coarser, a stored time is not shown at all.
--
-- **A contested event that can only be placed relative to others.** Often the
-- strongest claim a source supports is "after the pogrom, before the
-- armistice". That is recorded as a `happened_after` edge in the existing
-- relationship table -- not as columns here and not as a parallel table --
-- for the reason 0006 gives: `relationship` is already the one place the graph
-- traverses and the one place an edge's own visibility lives. A bound is
-- exactly the kind of claim that may need to stay private while both events
-- it connects are published, and that only works if it is an edge.
--
-- Re-runnable, like 0006 and 0007: MySQL commits implicitly around DDL, so a
-- file that fails partway cannot roll back and must be safe to run again.

-- --------------------------------------------------------------------------
-- The time of day
-- --------------------------------------------------------------------------
--
-- TIME, not DATETIME: like a DATE, a historical clock time is a reading off a
-- document, with no zone attached. "14:30" in a Bucharest police report is
-- 14:30 there, and converting it through a server's zone would corrupt it.

SET @ddl_event_time := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'event_detail'
      AND COLUMN_NAME = 'start_time') = 0,
  'ALTER TABLE event_detail
     ADD COLUMN start_time TIME NULL AFTER start_date,
     ADD COLUMN end_time   TIME NULL AFTER end_date',
  'DO 0');
PREPARE apply_event_time FROM @ddl_event_time;
EXECUTE apply_event_time;
DEALLOCATE PREPARE apply_event_time;

-- --------------------------------------------------------------------------
-- 'hour' and 'minute' on the precision ladder
-- --------------------------------------------------------------------------
--
-- Appended to the END of each ENUM so every existing value keeps its ordinal
-- and the change stays INSTANT. The list is therefore no longer in
-- coarse-to-fine order, which costs nothing: ordering is done with an explicit
-- FIELD() in `src/content/timeline.ts`, never by the ENUM's own ordinal.
--
-- MODIFY to the same definition is a no-op, so this needs no guard.
--
-- `relationship.date_precision` is deliberately NOT extended. A period on an
-- edge -- "minister from 1940 to 1941" -- is a span of days; an office does
-- not begin at 14:30. The two ladders are different vocabularies now, not two
-- copies of one.
ALTER TABLE event_detail
  MODIFY COLUMN date_precision
    ENUM('day', 'month', 'year', 'decade', 'unknown', 'hour', 'minute')
    NOT NULL DEFAULT 'unknown',
  MODIFY COLUMN start_precision
    ENUM('day', 'month', 'year', 'decade', 'unknown', 'hour', 'minute')
    NOT NULL DEFAULT 'unknown',
  MODIFY COLUMN end_precision
    ENUM('day', 'month', 'year', 'decade', 'unknown', 'hour', 'minute')
    NOT NULL DEFAULT 'unknown';

-- --------------------------------------------------------------------------
-- The relative-dating predicate
-- --------------------------------------------------------------------------
--
-- One predicate, read in both directions: an edge X -> A says X happened after
-- A, and the same row read from A says A happened before X. Two predicates
-- would let the same fact be asserted twice and disagree with itself.
INSERT IGNORE INTO relationship_predicate (code, label, inverse_label, is_symmetric) VALUES
  ('happened_after', 'Happened after', 'Happened before', 0);
