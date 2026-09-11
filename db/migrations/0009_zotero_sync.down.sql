-- 0009_zotero_sync (down)
--
-- Drops only the link bookkeeping. Sources imported from Zotero are ordinary
-- sources and survive the rollback -- they are cited in prose, and removing
-- them to undo a schema change would destroy research to tidy up a migration.
-- Rolling forward again re-links them on the next full sync, because the
-- matching pass recognises an unlinked source by DOI, ISBN or title and year.

DROP TABLE IF EXISTS source_zotero_link;
DROP TABLE IF EXISTS zotero_library_state;
