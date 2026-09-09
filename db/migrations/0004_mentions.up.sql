-- 0004_mentions (up)
--
-- Inline references extracted from prose.
--
-- A `mention` row is a PROJECTION of an essay's Markdown, rebuilt in the same
-- transaction as every save. Nothing writes to this table by hand. That is
-- what makes "everywhere this person is mentioned" trustworthy: the list
-- cannot drift from what the text actually says, because the text is the only
-- source it is derived from.
--
-- There is deliberately no visibility column. A mention is exactly as visible
-- as the item whose prose contains it -- the sentence itself displays it, so
-- any other answer would be incoherent.

CREATE TABLE IF NOT EXISTS mention (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The item whose prose contains the reference, normally an essay.
  from_item_id  BIGINT UNSIGNED NOT NULL,
  -- The entity referred to: a person, organization, place, event or artifact.
  to_item_id    BIGINT UNSIGNED NOT NULL,
  -- Which occurrence within the source text, counting from zero. Part of the
  -- unique key so the same person may be named repeatedly in one essay.
  occurrence    INT UNSIGNED    NOT NULL DEFAULT 0,
  -- What the prose actually said, which is often not the target's title:
  -- "Antonescu", "the Marshal", "her brother".
  anchor_text   VARCHAR(500)    NOT NULL,
  -- The surrounding sentence, shown as context in backlink listings. Safe to
  -- display whenever the *from* item is visible, because it is a quotation of
  -- text the viewer is already permitted to read.
  context       VARCHAR(1000)   NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mention_occurrence (from_item_id, to_item_id, occurrence),
  KEY ix_mention_to (to_item_id),
  CONSTRAINT fk_mention_from
    FOREIGN KEY (from_item_id) REFERENCES content_item (id) ON DELETE CASCADE,
  -- RESTRICT, matching the citation design: you cannot delete a person your
  -- writing still refers to. The alternative would silently leave a dangling
  -- reference in prose that still names them.
  CONSTRAINT fk_mention_to
    FOREIGN KEY (to_item_id) REFERENCES content_item (id) ON DELETE RESTRICT,
  CONSTRAINT ck_mention_not_self CHECK (from_item_id <> to_item_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
