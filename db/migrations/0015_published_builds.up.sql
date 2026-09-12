-- 0015_published_builds (up)
--
-- A compiled document can be published for download.
--
-- Until now `manuscript_build.audience` recorded which viewer a document was
-- assembled for, and the download route required an authenticated
-- administrator regardless -- the column was a safety label, not a permission.
-- This is what turns it into one, and it does so with two tables rather than a
-- flag, because a compiled file holds many sections at once and is the single
-- object where a mistake discloses everything to everybody.
--
-- Rule one: publishing is a deliberate act, recorded in its own table. No row
-- exists for any build that has ever been compiled, including every build that
-- already exists, so this migration makes nothing downloadable. Compiling
-- stays a private operation; an administrator publishes one build, on purpose.
--
-- The primary key is the manuscript, not the build. That is what keeps at most
-- one published build per manuscript: a second publication replaces the first
-- rather than joining it, which is what a reader following a stable URL should
-- get. Expressed as a key rather than as application logic, so it holds even
-- if a second caller is ever written.
--
-- (`relationship.period_key` folds NULL to '' in a generated column for the
-- same "at most one" shape. That trick is unavailable here: MySQL refuses a
-- STORED generated column whose base column carries a cascading foreign key,
-- and `manuscript_build.manuscript_item_id` does. A table whose key *is* the
-- manuscript needs no such fold.)
CREATE TABLE IF NOT EXISTS manuscript_published_build (
  manuscript_item_id BIGINT UNSIGNED NOT NULL,
  build_id           BIGINT UNSIGNED NOT NULL,
  published_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_by       BIGINT UNSIGNED NULL,
  PRIMARY KEY (manuscript_item_id),
  KEY ix_manuscript_published_build (build_id),
  KEY fk_manuscript_published_user (published_by),
  CONSTRAINT fk_manuscript_published_manuscript
    FOREIGN KEY (manuscript_item_id) REFERENCES content_item (id) ON DELETE CASCADE,
  CONSTRAINT fk_manuscript_published_build
    FOREIGN KEY (build_id) REFERENCES manuscript_build (id) ON DELETE CASCADE,
  CONSTRAINT fk_manuscript_published_user
    FOREIGN KEY (published_by) REFERENCES admin_user (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Rule two: what the document was assembled from.
--
-- The download route re-checks every one of these against the visibility rule
-- on every request, which is invariant 3 applied to a file that was written
-- once: the bytes are fixed, so the only honest way to serve them is to ask,
-- now, whether everything inside them is still published.
--
-- There is deliberately **no foreign key to content_item**. The row is a
-- record of what went in, not a live reference, and a cascade would delete it
-- when the chapter was deleted -- leaving a build that appears to contain
-- fewer items and is therefore *more* servable than before. Without the key,
-- a deleted chapter simply fails the re-check and the download stops, which is
-- the direction this application always fails in.
--
-- Rows exist only for builds compiled after this migration. That is how a
-- build from before the compiled-document withholding fix is kept out of
-- public reach: it has no recorded items, so it cannot satisfy a re-check and
-- cannot be published. Recompiling is the way to publish such a manuscript,
-- and recompiling is also what rewrites its withheld references.
CREATE TABLE IF NOT EXISTS manuscript_build_item (
  build_id        BIGINT UNSIGNED NOT NULL,
  content_item_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (build_id, content_item_id),
  KEY ix_manuscript_build_item_content (content_item_id),
  CONSTRAINT fk_manuscript_build_item_build
    FOREIGN KEY (build_id) REFERENCES manuscript_build (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
