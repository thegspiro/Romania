-- 0011_source_file (up)
--
-- A source can hold its own file.
--
-- Until now only `artifact_detail` carried a `file_object_id`, so a scanned
-- journal article had to be catalogued twice: once as a source, because that
-- is what a footnote cites, and once as an artifact, because that is what can
-- hold the PDF -- with nothing linking the two. The operator then had to
-- remember which half was which.
--
-- The column mirrors `artifact_detail.file_object_id` exactly, including
-- ON DELETE SET NULL, and for the same reason: deleting the bytes must not
-- silently delete the bibliographic record that describes them.
--
-- `file_object` is content-addressed and `insertFileObject` reuses a row for
-- identical bytes, so one file may now be owned by an artifact *and* a source
-- at once. That is why `findServableFile` had to learn about both owners in
-- the same change: a file whose only owner is a source would otherwise be
-- unreachable, and the rule for one owned by both is the one that already
-- applied to two artifacts -- visible if any owning item is visible.
--
-- Re-runnable, like 0006 through 0008: MySQL commits implicitly around DDL,
-- so a file that fails partway cannot roll back and must be safe to run again.

SET @ddl_source_file := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'source_detail'
      AND COLUMN_NAME = 'file_object_id') = 0,
  'ALTER TABLE source_detail
     ADD COLUMN file_object_id BIGINT UNSIGNED NULL AFTER csl_json,
     ADD KEY ix_source_detail_file (file_object_id)',
  'DO 0');
PREPARE apply_source_file FROM @ddl_source_file;
EXECUTE apply_source_file;
DEALLOCATE PREPARE apply_source_file;

-- Separate from the column so a re-run after a partial failure still adds the
-- constraint. Named explicitly, because the down-migration has to drop it by
-- name and a generated name is not stable across servers.
SET @ddl_source_file_fk := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'source_detail'
      AND CONSTRAINT_NAME = 'fk_source_detail_file') = 0,
  'ALTER TABLE source_detail
     ADD CONSTRAINT fk_source_detail_file
       FOREIGN KEY (file_object_id) REFERENCES file_object (id) ON DELETE SET NULL',
  'DO 0');
PREPARE apply_source_file_fk FROM @ddl_source_file_fk;
EXECUTE apply_source_file_fk;
DEALLOCATE PREPARE apply_source_file_fk;
