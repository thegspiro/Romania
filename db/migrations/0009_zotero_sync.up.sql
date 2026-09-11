-- 0009_zotero_sync (up)
--
-- Links sources to the Zotero items they came from, so a library can be synced
-- repeatedly instead of imported once.
--
-- Two tables rather than columns on source_detail:
--
--   * source_zotero_link is 1:1 with a source but not every source has one --
--     anything typed by hand or imported from BibTeX stays unlinked, and the
--     sync must be able to tell the difference. A nullable column pair on
--     source_detail would say the same thing less clearly and would put
--     Zotero's bookkeeping in the middle of the bibliographic record.
--
--   * zotero_library_state holds the library version the last sync reached.
--     It cannot be derived from MAX(item_version): a deletion in Zotero raises
--     the library version without touching any item this side still holds, so
--     a derived value would ask for the same deletions on every sync.

CREATE TABLE IF NOT EXISTS zotero_library_state (
  library_type    ENUM('user', 'group') NOT NULL,
  library_id      VARCHAR(32)     NOT NULL,
  -- The Last-Modified-Version the last successful sync observed. The next
  -- sync asks Zotero for everything changed since, so a routine sync costs
  -- one request rather than a walk of the whole library.
  last_version    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_synced_at  DATETIME(3)     NULL,
  -- Counts from the last run, for the admin listing. Not authoritative.
  created_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  updated_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  linked_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  deleted_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (library_type, library_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS source_zotero_link (
  content_item_id      BIGINT UNSIGNED NOT NULL,
  library_type         ENUM('user', 'group') NOT NULL,
  library_id           VARCHAR(32)     NOT NULL,
  -- Zotero's item key: eight uppercase alphanumerics today, stored wider
  -- because it is their identifier to change, not ours.
  item_key             VARCHAR(32)     NOT NULL,
  -- Version last applied here. A later sync sees a higher version from the
  -- API and knows the record changed.
  item_version         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- Set when Zotero reports the item deleted. The source itself is kept: it
  -- may already be cited in prose, and rebuilding references over a deleted
  -- source would leave a dangling [[cite:...]]. The operator decides.
  deleted_in_zotero_at DATETIME(3)     NULL,
  linked_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  synced_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (content_item_id),
  -- One Zotero item maps to at most one source. This is what makes the sync
  -- an upsert rather than an append, and it is why re-running a sync that
  -- failed halfway cannot duplicate what it already imported.
  UNIQUE KEY uq_source_zotero_link_item (library_type, library_id, item_key),
  KEY ix_source_zotero_link_deleted (deleted_in_zotero_at),
  CONSTRAINT fk_source_zotero_link_item
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
