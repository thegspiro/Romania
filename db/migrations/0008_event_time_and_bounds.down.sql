-- 0008_event_time_and_bounds (down)
--
-- Reverse order. Note what is lost: every recorded time of day, and every
-- relative bound asserted with `happened_after`. Both are research, not
-- derived data.
--
-- The precision columns have to be narrowed AFTER the rows using the two new
-- values are corrected, or MySQL has no valid value for them. 'hour' and
-- 'minute' both fall back to 'day', which is the finest claim the narrowed
-- ladder can still make and is true of every row that held them.

UPDATE event_detail SET date_precision  = 'day' WHERE date_precision  IN ('hour', 'minute');
UPDATE event_detail SET start_precision = 'day' WHERE start_precision IN ('hour', 'minute');
UPDATE event_detail SET end_precision   = 'day' WHERE end_precision   IN ('hour', 'minute');

ALTER TABLE event_detail
  MODIFY COLUMN date_precision
    ENUM('day', 'month', 'year', 'decade', 'unknown') NOT NULL DEFAULT 'unknown',
  MODIFY COLUMN start_precision
    ENUM('day', 'month', 'year', 'decade', 'unknown') NOT NULL DEFAULT 'unknown',
  MODIFY COLUMN end_precision
    ENUM('day', 'month', 'year', 'decade', 'unknown') NOT NULL DEFAULT 'unknown';

ALTER TABLE event_detail
  DROP COLUMN end_time,
  DROP COLUMN start_time;

-- The edges first: relationship_predicate is referenced by a RESTRICT foreign
-- key, so a bound asserted with this verb would refuse the DELETE below.
DELETE FROM relationship
 WHERE predicate_id IN (
   SELECT id FROM relationship_predicate WHERE code = 'happened_after'
 );

DELETE FROM relationship_predicate WHERE code = 'happened_after';
