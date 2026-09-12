-- 0014_predicate_domain_range (down)
--
-- Drops the two columns, which is the whole of this migration's footprint.
--
-- What is lost is the typing of the vocabulary, including any narrowing the
-- operator did in /admin/vocabulary afterwards. No `relationship` row is
-- touched: the constraint only ever governed what could be asserted, never
-- what had been, so every recorded edge survives a rollback unchanged and the
-- application goes back to accepting any pair for any verb.
--
-- Guarded on the column's presence so the file is re-runnable, for the reason
-- the up-migration gives.

SET @ddl := (
  SELECT IF(
    COUNT(*) = 2,
    'ALTER TABLE relationship_predicate
       DROP COLUMN range_kinds,
       DROP COLUMN domain_kinds',
    'DO 0')
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship_predicate'
     AND COLUMN_NAME IN ('domain_kinds', 'range_kinds')
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
