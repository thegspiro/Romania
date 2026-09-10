-- 0006_timeline (up)
--
-- Chronology.
--
-- Events were already a content kind with real DATE columns, but nothing in
-- the application ordered by them, so the material could not be read as a
-- sequence. This migration adds the fields a chronology needs to be honest
-- about historical dating, a generated key to sort by, prose of an event's
-- own, and the paragraph anchor that lets a backlink land on the sentence
-- that named the event rather than the top of the essay.
--
-- Re-runnability
-- --------------
-- MySQL commits implicitly around DDL, so a file that fails halfway cannot
-- roll back and must be safe to run again. MySQL 8 has no
-- `ADD COLUMN IF NOT EXISTS` (that is MariaDB), so each ALTER below is guarded
-- by a look at information_schema and executed through PREPARE. Every column a
-- statement adds is added by that one statement, so the guard's single probe
-- column is a faithful witness for all of them.

-- --------------------------------------------------------------------------
-- event_detail: precision per endpoint, approximation, prose, sort key
-- --------------------------------------------------------------------------
--
-- `date_precision` is deliberately NOT dropped. It is the column the existing
-- code writes and reads, and an applied migration cannot be edited later to
-- put it back. The application from here on writes it equal to
-- `start_precision`, so it stays a correct answer to the question it always
-- answered.

SET @ddl_event := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'event_detail'
      AND COLUMN_NAME = 'start_precision') = 0,
  'ALTER TABLE event_detail
     ADD COLUMN start_precision ENUM(''day'', ''month'', ''year'', ''decade'', ''unknown'')
                                NOT NULL DEFAULT ''unknown'' AFTER date_precision,
     ADD COLUMN end_precision   ENUM(''day'', ''month'', ''year'', ''decade'', ''unknown'')
                                NOT NULL DEFAULT ''unknown'' AFTER start_precision,
     ADD COLUMN is_circa        TINYINT(1) NOT NULL DEFAULT 0 AFTER end_precision,
     ADD COLUMN body_markdown   MEDIUMTEXT NULL,
     ADD COLUMN sort_date       DATE GENERATED ALWAYS AS (COALESCE(start_date, end_date)) STORED,
     ADD KEY ix_event_detail_sort (sort_date)',
  'DO 0');
PREPARE apply_event_columns FROM @ddl_event;
EXECUTE apply_event_columns;
DEALLOCATE PREPARE apply_event_columns;

-- Carry the old single precision onto both endpoints.
--
-- Safe to run again: from this migration onward the application always writes
-- date_precision equal to start_precision, so a row can never again be in the
-- state this matches (both endpoints unknown while the legacy column is not)
-- unless it was never touched since the upgrade -- which is exactly the row
-- this is for.
UPDATE event_detail
   SET start_precision = date_precision,
       end_precision   = date_precision
 WHERE start_precision = 'unknown'
   AND end_precision   = 'unknown'
   AND date_precision <> 'unknown';

-- --------------------------------------------------------------------------
-- mention: which paragraph the reference sat in
-- --------------------------------------------------------------------------
--
-- Still a projection of the prose. Only rebuildReferences writes it, in the
-- same transaction as the text it describes, so a stored anchor cannot point
-- at a paragraph the current text does not have.
--
-- Nullable because a mention whose offset cannot be mapped to a top-level
-- block stores nothing rather than a wrong number, and because every row that
-- already exists predates the column.

SET @ddl_mention := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'mention'
      AND COLUMN_NAME = 'block_index') = 0,
  'ALTER TABLE mention
     ADD COLUMN block_index INT UNSIGNED NULL AFTER occurrence',
  'DO 0');
PREPARE apply_mention_columns FROM @ddl_mention;
EXECUTE apply_mention_columns;
DEALLOCATE PREPARE apply_mention_columns;

-- --------------------------------------------------------------------------
-- Event-shaped predicates
-- --------------------------------------------------------------------------
--
-- Events connect to people, places and organizations through the same typed
-- edge table as everything else -- there is no second kind of edge to teach
-- the graph, the visibility rule and the delete guard about. What was missing
-- was vocabulary: 'participated_in' and 'held_at' already existed, but not the
-- verbs a historian actually needs.
--
-- INSERT IGNORE, matching 0002: re-runnable, and a predicate the operator has
-- deleted does not reappear with a different id.
INSERT IGNORE INTO relationship_predicate (code, label, inverse_label, is_symmetric) VALUES
  ('organized',       'Organized',        'Organized by',    0),
  ('attended',        'Attended',         'Attended by',     0),
  ('commanded',       'Commanded',        'Commanded by',    0),
  ('targeted',        'Targeted',         'Targeted by',     0),
  ('witnessed',       'Witnessed',        'Witnessed by',    0),
  ('caused',          'Caused',           'Caused by',       0),
  ('part_of',         'Part of',          'Includes',        0);
