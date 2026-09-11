-- 0010_essay_revisions (up)
--
-- Version history for essay prose.
--
-- Prose is the only content in this application that cannot be recovered from
-- anywhere else. A source can be re-imported from Zotero, an artifact re-read
-- from its file, an entity retyped from the record it came from -- a paragraph
-- overwritten by accident is simply gone. Until now nothing kept the previous
-- text.
--
-- Three properties, each of which the schema is shaped to give:
--
--   * **Append-only.** Nothing updates or deletes a revision. A history that
--     can be edited answers a different question from the one it is asked.
--
--   * **Whole snapshots, not diffs.** The row *is* the text. Storing diffs
--     would put a reconstruction step between the operator and their own
--     writing, and a reconstruction can be wrong. A chapter is tens of
--     kilobytes; at one researcher's rate of saving this costs nothing worth
--     optimising.
--
--   * **A revision records the state after a save**, not the state before it.
--     So the newest revision always equals the current essay, the list reads
--     forwards, and "restore revision 7" means "make the text what revision 7
--     holds" without an off-by-one.
--
-- Restoring writes a new revision rather than rewinding to an old one, so the
-- history of a mistake and its correction both survive.

CREATE TABLE IF NOT EXISTS essay_revision (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_item_id  BIGINT UNSIGNED NOT NULL,
  -- 1-based and per essay, so the operator can refer to "revision 7" of a
  -- chapter rather than to an opaque id. Allocated inside the same
  -- transaction as the save, which already holds a lock on the content_item
  -- row, so two concurrent saves cannot claim one number.
  revision_number  INT UNSIGNED    NOT NULL,
  title            VARCHAR(500)    NOT NULL,
  body_markdown    MEDIUMTEXT      NOT NULL,
  status           ENUM('draft', 'in_review', 'final') NOT NULL,
  word_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  -- What produced this revision: an ordinary save, or restoring an earlier
  -- one. A restore also records which revision it was taken from, so the
  -- listing can say so rather than showing an unexplained jump backwards.
  source           ENUM('save', 'restore') NOT NULL DEFAULT 'save',
  restored_from    INT UNSIGNED    NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_essay_revision_number (content_item_id, revision_number),
  -- The listing reads newest first for one essay.
  KEY ix_essay_revision_item (content_item_id, revision_number DESC),
  CONSTRAINT fk_essay_revision_item
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Existing essays get revision 1 from their current text, so a history that
-- starts today still has a floor rather than an empty list. INSERT IGNORE
-- keeps the migration re-runnable: the unique key rejects a second attempt at
-- the same (essay, 1) rather than duplicating it.
INSERT IGNORE INTO essay_revision
  (content_item_id, revision_number, title, body_markdown, status, word_count, source, created_at)
SELECT ci.id, 1, ci.title, ed.body_markdown, ed.status, ed.word_count, 'save', ci.updated_at
  FROM content_item ci
  JOIN essay_detail ed ON ed.content_item_id = ci.id
 WHERE ci.kind = 'essay';
