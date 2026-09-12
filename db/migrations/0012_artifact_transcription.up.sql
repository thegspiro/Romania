-- 0012_artifact_transcription (up)
--
-- An artifact can carry its own text.
--
-- A photograph of a document is not searchable, not quotable, and not citable
-- by page. The transcription is what turns 400 phone photographs of one dosar
-- into something the rest of this application can reach: it is matched by the
-- `LIKE` search, it is exported as text alongside the catalogue, and -- the
-- part that matters most -- it is **prose**.
--
-- Prose here means what it means for an essay and for an agent's biography:
-- `[[person:ion-antonescu]]` written inside a transcription is projected into
-- `mention` by `rebuildReferences`, in the same transaction as the save, so
-- the document's own words show up on the page of the person it names. A
-- transcription that could not be linked would be a dead end, and retrofitting
-- that later would mean re-projecting every transcription already typed.
--
-- One prose column per kind, as everywhere else: the projection is rebuilt
-- wholesale from one string, and a mention's context and paragraph anchor have
-- to point somewhere definite.
--
-- MEDIUMTEXT rather than TEXT: TEXT is 64 KB, and a long report in a fond can
-- exceed that once it is typed out in full.
--
-- `transcription_language` is separate from `content_item.language`, which
-- describes the artifact record. A German order held in a Romanian archive has
-- a Romanian catalogue entry and a German text, and the renderer needs to say
-- which is which for a screen reader and for hyphenation.
--
-- Re-runnable, like 0006 through 0011.

SET @ddl_transcription := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'artifact_detail'
      AND COLUMN_NAME = 'transcription') = 0,
  'ALTER TABLE artifact_detail
     ADD COLUMN transcription MEDIUMTEXT NULL,
     ADD COLUMN transcription_language VARCHAR(20) NULL',
  'DO 0');
PREPARE apply_transcription FROM @ddl_transcription;
EXECUTE apply_transcription;
DEALLOCATE PREPARE apply_transcription;
