-- 0006_relationship_roles (down)
--
-- Reverses the qualifying columns and narrows the unique key back.
--
-- This rollback LOSES DATA, unavoidably and by definition. The narrow key
-- (from_item_id, predicate_id, to_item_id) cannot hold two edges that differ
-- only by office or period, so restoring it means the extra ones cannot
-- survive. The lowest id of each group is kept, which is the row that existed
-- before this migration whenever the qualified ones were added afterwards.
--
-- Take a dump before rolling this back if any office or period has been
-- recorded. The information is not recoverable from the remaining rows.

-- Edges asserted with a predicate this migration introduced have nowhere to
-- go once the predicate does, and the foreign key is RESTRICT, so they must
-- be removed before it.
DELETE r FROM relationship r
  JOIN relationship_predicate p ON p.id = r.predicate_id
 WHERE p.code IN ('held_office_in', 'commanded', 'reported_to');

DELETE FROM relationship_predicate
 WHERE code IN ('held_office_in', 'commanded', 'reported_to');

-- Collapse what the narrow key cannot express, keeping the earliest row of
-- each (from, predicate, to) group.
DELETE r FROM relationship r
  JOIN (
    SELECT from_item_id, predicate_id, to_item_id, MIN(id) AS keep_id
      FROM relationship
     GROUP BY from_item_id, predicate_id, to_item_id
    HAVING COUNT(*) > 1
  ) duplicates
    ON duplicates.from_item_id = r.from_item_id
   AND duplicates.predicate_id = r.predicate_id
   AND duplicates.to_item_id = r.to_item_id
 WHERE r.id <> duplicates.keep_id;

-- Narrow the unique key. Guarded on the column count so a re-run is a no-op.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 4,
    'ALTER TABLE relationship
       DROP INDEX uq_relationship_edge,
       ADD UNIQUE KEY uq_relationship_edge (from_item_id, predicate_id, to_item_id)',
    'DO 0')
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND INDEX_NAME = 'uq_relationship_edge'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := (
  SELECT IF(
    COUNT(*) > 0,
    'ALTER TABLE relationship DROP KEY ix_relationship_period',
    'DO 0')
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND INDEX_NAME = 'ix_relationship_period'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The generated column goes before the columns it is generated from.
SET @ddl := (
  SELECT IF(
    COUNT(*) > 0,
    'ALTER TABLE relationship DROP COLUMN period_key',
    'DO 0')
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND COLUMN_NAME = 'period_key'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The checks go in the same statement as the columns they constrain; MySQL
-- refuses to drop a column a check constraint still references.
SET @ddl := (
  SELECT IF(
    COUNT(*) > 0,
    'ALTER TABLE relationship
       DROP CHECK ck_relationship_period,
       DROP CHECK ck_relationship_role_title,
       DROP COLUMN role_title,
       DROP COLUMN start_date,
       DROP COLUMN end_date,
       DROP COLUMN date_precision',
    'DO 0')
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND COLUMN_NAME = 'role_title'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
