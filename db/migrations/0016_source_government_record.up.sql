-- 0016_source_government_record (up)
--
-- Released government records: State Department cables, CIA reports and the
-- like, catalogued as sources.
--
-- A declassified document is cited like any other archival source, so it is a
-- source -- one item, holding its PDF, cited with `[[cite:...]]`. What it has
-- that other sources do not is a set of identifiers the researcher uses to find
-- it again: a CREST document number, a FOIA case, a cable number, a FRUS
-- volume and document, a NARA record group, entry, box and folder, and the
-- marking and dates of its classification and release. None of those has a
-- home in CSL-JSON, and squeezing them into `note` would make them unsearchable
-- and unfilterable.
--
-- A separate table keyed 1:1 on the source rather than columns on
-- `source_detail`, for two reasons:
--
--   * Most sources are books and articles. The row exists only for a source
--     that is a government record, so "is this a government record?" is a
--     join rather than a test of seventeen columns for NULL.
--   * The Zotero sync rewrites `source_detail` wholesale. It never touches this
--     table, so a sync cannot erase a CREST number typed here.
--
-- The citation still comes from `csl_json` and the vendored Chicago style. The
-- fields that Chicago has a place for (document type, number, archive and
-- location within it) fill the CSL record at render time **only where the
-- operator left it blank** -- see `citableCsl` in
-- src/content/government-records.ts. Nothing here is written into csl_json.
--
-- The original document date is not repeated here: it is the CSL `issued`
-- date, which the citation already prints.
--
-- Re-runnable, like 0006 onward: MySQL commits implicitly around DDL.

CREATE TABLE IF NOT EXISTS source_government_record (
  content_item_id          BIGINT UNSIGNED NOT NULL,
  -- "Department of State", "Central Intelligence Agency", ...
  originating_agency       VARCHAR(255)    NULL,
  -- "Telegram", "Memorandum", "Intelligence report", ...
  document_type            VARCHAR(100)    NULL,
  from_party               VARCHAR(255)    NULL,
  to_party                 VARCHAR(255)    NULL,
  -- As marked on the document, caveats included: "SECRET NOFORN".
  original_classification  VARCHAR(100)    NULL,
  cable_number             VARCHAR(100)    NULL,
  -- CIA Records Search Tool document number, e.g. CIA-RDP82-00457R000400330004-2.
  crest_number             VARCHAR(100)    NULL,
  foia_case_number         VARCHAR(100)    NULL,
  frus_volume              VARCHAR(255)    NULL,
  frus_document_number     VARCHAR(50)     NULL,
  nara_record_group        VARCHAR(50)     NULL,
  nara_entry               VARCHAR(100)    NULL,
  nara_box                 VARCHAR(50)     NULL,
  nara_folder              VARCHAR(255)    NULL,
  -- Calendar days, not instants.
  declassified_on          DATE            NULL,
  released_on              DATE            NULL,
  -- Where the released copy came from: "CIA Electronic Reading Room",
  -- "State Department FOIA Virtual Reading Room", ...
  release_collection       VARCHAR(255)    NULL,
  PRIMARY KEY (content_item_id),
  KEY ix_source_gov_agency (originating_agency),
  KEY ix_source_gov_classification (original_classification),
  KEY ix_source_gov_collection (release_collection),
  KEY ix_source_gov_crest (crest_number),
  KEY ix_source_gov_foia (foia_case_number),
  KEY ix_source_gov_cable (cable_number),
  -- Keyed on content_item rather than source_detail, like every detail table:
  -- deleting the source deletes its catalogue record with it.
  CONSTRAINT fk_source_gov_item
    FOREIGN KEY (content_item_id) REFERENCES content_item (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
