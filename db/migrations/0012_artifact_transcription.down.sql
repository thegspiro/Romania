-- 0012_artifact_transcription (down)
--
-- Drops the transcriptions. There is nowhere else to put them: a transcription
-- is typed by hand from a photograph and is not derivable from anything else
-- in the schema, so this rollback destroys work. Take a dump first.
--
-- The `mention` rows projected from transcriptions are deliberately left
-- alone. They are ON DELETE CASCADE from `content_item`, not from this column,
-- and the artifacts themselves survive -- so rather than delete rows this
-- migration cannot reason about, the next save of each artifact rebuilds its
-- projection from the prose that is left, which after this is none. That is
-- `rebuildReferences` doing its job, and it is why nothing here writes to
-- `mention` directly.

SET @undo_transcription := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'artifact_detail'
      AND COLUMN_NAME = 'transcription') = 1,
  'ALTER TABLE artifact_detail
     DROP COLUMN transcription,
     DROP COLUMN transcription_language',
  'DO 0');
PREPARE undo_transcription FROM @undo_transcription;
EXECUTE undo_transcription;
DEALLOCATE PREPARE undo_transcription;
