-- 0013_essay_shares (up)
--
-- A supervisor can read one unpublished chapter, and comment on it.
--
-- This is the one deliberate exception to the rule the whole application is
-- built around. Everything else here answers "may this viewer see this item?"
-- with "only if it is published or you are the operator". A share link answers
-- "yes, this one item, to whoever holds this token, until it expires."
--
-- That is worth building because the alternative is worse: without it the real
-- draft leaves for Word and this becomes the place a stale copy lives. But it
-- is a hole by design, so the schema is shaped to keep the hole small.
--
--   * **One essay per link.** Not a manuscript, not a set. One leaked URL
--     exposes one chapter, which is why `manuscript_build.audience` exists and
--     why this does not reuse it.
--   * **The token is stored hashed**, exactly as a session token is. A dump of
--     this table does not let anyone read anything.
--   * **Expiry is mandatory** -- the column is NOT NULL. A link that lives
--     forever is an account nobody remembers issuing.
--   * **Revocation is separate from expiry** and takes effect on the next
--     request, because "I sent that to the wrong address" needs an answer
--     faster than waiting out a deadline.
--
-- What a link holder sees is decided in `src/content/visibility.ts`, not here:
-- the share Viewer widens the filter by exactly this one id and nothing else,
-- so a private person named in the chapter stays withheld from them exactly as
-- it would from any other visitor.

CREATE TABLE IF NOT EXISTS essay_share (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_item_id BIGINT UNSIGNED NOT NULL,
  -- sha256(token), hex. The token itself is shown once, at creation, and is
  -- never stored -- the same contract as `session.token_sha256` and recovery
  -- codes.
  token_sha256    CHAR(64)        NOT NULL,
  -- Who it was issued to, in the operator's own words: "Prof. Ionescu, draft
  -- 2". For the operator's memory only; never shown to the reader.
  label           VARCHAR(190)    NULL,
  expires_at      DATETIME(3)     NOT NULL,
  revoked_at      DATETIME(3)     NULL,
  -- Enough to answer "has she opened it yet?" without an access log. A full
  -- audit trail of every view was considered and left out: this answers the
  -- question the operator actually asks, and stores less about a third party.
  last_viewed_at  DATETIME(3)     NULL,
  view_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_essay_share_token (token_sha256),
  KEY ix_essay_share_item (content_item_id, created_at),
  CONSTRAINT fk_essay_share_item
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- --------------------------------------------------------------------------
-- Comments
-- --------------------------------------------------------------------------
--
-- Anchored to `block_index`, the same 1-based paragraph numbering `mention`
-- uses and `renderProse` emits as `id="pN"`. Reusing it means a comment lands
-- next to the paragraph it was written about, and that editing a different
-- paragraph does not move it.
--
-- It is an anchor, not a foreign key: prose is edited, and a paragraph can be
-- deleted out from under a comment. A comment whose paragraph is gone is shown
-- unanchored rather than discarded -- the supervisor's words outlive the
-- sentence that prompted them, and quietly dropping feedback would be worse
-- than showing it without a home.
--
-- `share_id` is ON DELETE SET NULL, not CASCADE: revoking or deleting a link
-- must not delete the feedback that came through it.

CREATE TABLE IF NOT EXISTS essay_share_comment (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Denormalised from the share so the operator's reads never need the link
  -- row, which may be gone.
  content_item_id BIGINT UNSIGNED NOT NULL,
  share_id        BIGINT UNSIGNED NULL,
  -- The paragraph commented on, or NULL for the chapter as a whole.
  block_index     INT UNSIGNED    NULL,
  body            TEXT            NOT NULL,
  -- The operator marks a comment dealt with; the reader never sees this.
  resolved_at     DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_share_comment_item (content_item_id, block_index, created_at),
  KEY ix_share_comment_share (share_id),
  CONSTRAINT fk_share_comment_item
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE,
  CONSTRAINT fk_share_comment_share
    FOREIGN KEY (share_id) REFERENCES essay_share (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
