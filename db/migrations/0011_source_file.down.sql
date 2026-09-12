-- 0011_source_file (down)
--
-- Drops the link, not the files. A `file_object` row and its bytes on disk
-- survive: they may still be owned by an artifact, and even when they are not,
-- deleting a scan because a column is being rolled back would destroy
-- something the database is the only record of.
--
-- The effect of rolling back is that a file attached only to a source becomes
-- unreachable through `/files/:id/:variant` again -- it has no owning artifact,
-- and that route serves nothing an item does not own. The bytes are still in
-- STORAGE_ROOT and still named by their hash.
--
-- Guarded both ways: the constraint has to go before the column it is on.

SET @undo_source_file_fk := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'source_detail'
      AND CONSTRAINT_NAME = 'fk_source_detail_file') = 1,
  'ALTER TABLE source_detail DROP FOREIGN KEY fk_source_detail_file',
  'DO 0');
PREPARE undo_source_file_fk FROM @undo_source_file_fk;
EXECUTE undo_source_file_fk;
DEALLOCATE PREPARE undo_source_file_fk;

SET @undo_source_file := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'source_detail'
      AND COLUMN_NAME = 'file_object_id') = 1,
  'ALTER TABLE source_detail
     DROP KEY ix_source_detail_file,
     DROP COLUMN file_object_id',
  'DO 0');
PREPARE undo_source_file FROM @undo_source_file;
EXECUTE undo_source_file;
DEALLOCATE PREPARE undo_source_file;
