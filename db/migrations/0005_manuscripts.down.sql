-- 0005_manuscripts (down)
--
-- Reverse dependency order, then restore the original kind vocabulary.
-- Any manuscript rows must go first, or the narrowed ENUM would have no valid
-- value for them.

DROP TABLE IF EXISTS manuscript_build;
DROP TABLE IF EXISTS manuscript_section;
DROP TABLE IF EXISTS manuscript_detail;

DELETE FROM content_item WHERE kind = 'manuscript';

ALTER TABLE content_item
  MODIFY COLUMN kind ENUM('source', 'artifact', 'essay', 'person',
                          'organization', 'place', 'event') NOT NULL;
