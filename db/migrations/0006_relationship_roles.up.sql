-- 0006_relationship_roles (up)
--
-- Roles, positions and periods on a relationship edge.
--
-- Until now an edge could say that Antonescu was a member of an organization
-- but not *as what* or *when*. A dissertation about who held which office,
-- and for how long, needs both, and needs them on the edge rather than on
-- either endpoint: an office is a property of the connection, not of the
-- person or of the institution.
--
-- This stays inside the existing edge table on purpose. `relationship` is
-- already the one place the graph traverses and the one place the edge's own
-- visibility lives; a parallel "position" table would put a second edge type
-- outside that seam and force every visibility decision to be written twice.
--
-- The unique key has to widen for the same reason. One person may hold two
-- different offices at the same organization in succession -- minister, then
-- prime minister -- and the old key (from, predicate, to) allowed only one
-- such edge. It cannot simply gain the nullable columns: MySQL treats NULLs
-- as distinct in a unique index, so two undated, unqualified duplicates would
-- both be accepted and the duplicate check would stop working entirely.
-- `period_key` is therefore a STORED generated column that folds NULL to the
-- empty string, which restores exactly the old behaviour for an unqualified
-- edge while letting a qualified one differ.
--
-- Every statement is guarded against its own effect so the file is
-- re-runnable: MySQL commits implicitly around DDL, so a file that fails
-- partway cannot be rolled back and must be safe to run again.

-- The qualifying columns, and the constraints that keep them coherent.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE relationship
       ADD COLUMN role_title VARCHAR(255) NULL AFTER predicate_id,
       ADD COLUMN start_date DATE NULL AFTER role_title,
       ADD COLUMN end_date DATE NULL AFTER start_date,
       ADD COLUMN date_precision ENUM(''day'', ''month'', ''year'', ''decade'', ''unknown'')
                  NOT NULL DEFAULT ''unknown'' AFTER end_date,
       ADD CONSTRAINT ck_relationship_period
         CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
       ADD CONSTRAINT ck_relationship_role_title
         CHECK (role_title IS NULL OR role_title <> '''')',
    'DO 0')
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND COLUMN_NAME = 'role_title'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The normalised qualifier, for the unique key only. Never read by the
-- application: it exists so the database can tell "the same edge again" from
-- "the same pair, a different office or a different period".
--
-- CAST rather than DATE_FORMAT because CAST(DATE AS CHAR) is unambiguously
-- deterministic; a generated column may not depend on session state.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE relationship
       ADD COLUMN period_key VARCHAR(300)
         GENERATED ALWAYS AS (CONCAT(
           COALESCE(role_title, ''''), ''|'',
           COALESCE(CAST(start_date AS CHAR), ''''), ''|'',
           COALESCE(CAST(end_date AS CHAR), '''')
         )) STORED NOT NULL',
    'DO 0')
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND COLUMN_NAME = 'period_key'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Widen the unique key. Guarded on the column count of the existing index, so
-- a re-run finds four columns and does nothing.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 3,
    'ALTER TABLE relationship
       DROP INDEX uq_relationship_edge,
       ADD UNIQUE KEY uq_relationship_edge
         (from_item_id, predicate_id, to_item_id, period_key)',
    'DO 0')
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND INDEX_NAME = 'uq_relationship_edge'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The graph may be asked for the network as it stood in a given year, which
-- filters on this pair.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE relationship ADD KEY ix_relationship_period (start_date, end_date)',
    'DO 0')
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship'
     AND INDEX_NAME = 'ix_relationship_period'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Predicates that read naturally with an office attached. The starter
-- vocabulary already covers membership and employment; these cover holding a
-- post and the succession between two holders of one.
INSERT IGNORE INTO relationship_predicate (code, label, inverse_label, is_symmetric) VALUES
  ('held_office_in', 'Held office in', 'Office held by', 0),
  ('commanded',      'Commanded',      'Commanded by',  0),
  ('reported_to',    'Reported to',    'Superior of',   0);
