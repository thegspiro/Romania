-- 0005_manuscripts (up)
--
-- The structure behind the pieces.
--
-- Each essay is publishable on its own page. A manuscript records how those
-- pieces assemble into one document, so the same material serves both without
-- being written twice.

-- A manuscript is itself a content item, so it inherits slug, visibility,
-- publishing and audit behaviour rather than reimplementing them. Appending a
-- value to the end of an ENUM is an INSTANT operation in MySQL 8, so this does
-- not rewrite the table.
ALTER TABLE content_item
  MODIFY COLUMN kind ENUM('source', 'artifact', 'essay', 'person',
                          'organization', 'place', 'event', 'manuscript') NOT NULL;

CREATE TABLE IF NOT EXISTS manuscript_detail (
  content_item_id           BIGINT UNSIGNED NOT NULL,
  subtitle                  VARCHAR(500)    NULL,
  -- Title-page metadata. Held here rather than as a front-matter section
  -- because a title page is structured fields, not prose.
  author_name               VARCHAR(255)    NULL,
  degree                    VARCHAR(190)    NULL,
  institution               VARCHAR(255)    NULL,
  submitted_on              DATE            NULL,
  abstract_markdown         MEDIUMTEXT      NULL,
  acknowledgements_markdown MEDIUMTEXT      NULL,
  -- Whether Pandoc numbers headings in the compiled document.
  number_sections           TINYINT(1)      NOT NULL DEFAULT 1,
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_manuscript_detail_item
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- The outline.
--
-- Deliberately an ordered list with a depth column rather than a
-- parent_section_id tree. MySQL's self-referencing foreign keys have awkward
-- cascade behaviour, and every operation this table needs -- reordering,
-- prev/next navigation, moving a chapter with its subsections, walking the
-- whole thing to compile -- is a linear scan over (position). It still renders
-- as a nested tree; depth is what makes it one.
CREATE TABLE IF NOT EXISTS manuscript_section (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  manuscript_item_id  BIGINT UNSIGNED NOT NULL,
  -- The essay (or other item) placed at this point in the document.
  content_item_id     BIGINT UNSIGNED NOT NULL,
  -- Ordering within the whole manuscript. Sparse values are fine; only the
  -- relative order matters.
  position            INT UNSIGNED    NOT NULL,
  -- 0 is a top-level part or chapter; each increment is one heading level
  -- deeper. Capped because a document nested more than six deep is a mistake,
  -- and because compilation demotes headings by this amount.
  depth               TINYINT UNSIGNED NOT NULL DEFAULT 0,
  role                ENUM('front_matter', 'body', 'appendix', 'back_matter')
                                      NOT NULL DEFAULT 'body',
  -- A chapter may be titled differently inside the dissertation than it is as
  -- a standalone page. NULL means use the item's own title.
  title_override      VARCHAR(500)    NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- An item appears at most once WITHIN a manuscript, but may appear in
  -- several manuscripts -- which is what lets a chapter also be a journal
  -- article without duplicating it.
  UNIQUE KEY uq_manuscript_section_item (manuscript_item_id, content_item_id),
  KEY ix_manuscript_section_order (manuscript_item_id, position, id),
  KEY ix_manuscript_section_content (content_item_id),
  CONSTRAINT fk_manuscript_section_manuscript
    FOREIGN KEY (manuscript_item_id) REFERENCES content_item (id) ON DELETE CASCADE,
  CONSTRAINT fk_manuscript_section_content
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE,
  CONSTRAINT ck_manuscript_section_depth CHECK (depth <= 5),
  CONSTRAINT ck_manuscript_section_not_self
    CHECK (manuscript_item_id <> content_item_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- A compiled document.
--
-- This is the one place a visibility mistake would leak everything at once: a
-- single file containing many sections. `audience` records the viewer scope
-- the document was assembled for, and the download route checks it on every
-- request. An 'admin' build contains private material and must never be
-- served to anyone else.
CREATE TABLE IF NOT EXISTS manuscript_build (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  manuscript_item_id  BIGINT UNSIGNED NOT NULL,
  format              ENUM('pdf', 'docx', 'html', 'latex', 'markdown') NOT NULL,
  audience            ENUM('admin', 'public') NOT NULL,
  state               ENUM('pending', 'running', 'succeeded', 'failed')
                                      NOT NULL DEFAULT 'pending',
  -- Populated once the worker has stored the output.
  file_object_id      BIGINT UNSIGNED NULL,
  section_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  word_count          INT UNSIGNED    NOT NULL DEFAULT 0,
  -- Pandoc's own output, kept whether the build succeeded or failed: a
  -- successful build with warnings is worth reading too.
  log                 MEDIUMTEXT      NULL,
  requested_by        BIGINT UNSIGNED NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at         DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY ix_manuscript_build_manuscript (manuscript_item_id, created_at),
  KEY ix_manuscript_build_state (state),
  CONSTRAINT fk_manuscript_build_manuscript
    FOREIGN KEY (manuscript_item_id) REFERENCES content_item (id) ON DELETE CASCADE,
  -- Deleting the stored bytes leaves the build record as evidence that a
  -- compile happened, rather than removing the history.
  CONSTRAINT fk_manuscript_build_file
    FOREIGN KEY (file_object_id) REFERENCES file_object (id) ON DELETE SET NULL,
  CONSTRAINT fk_manuscript_build_user
    FOREIGN KEY (requested_by) REFERENCES admin_user (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
