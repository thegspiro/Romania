-- 0016_source_government_record (down)
--
-- Drops the government-record catalogue. The sources themselves, their CSL
-- records and their files are untouched; what is lost is the identifiers typed
-- into this table (CREST, FOIA, cable, FRUS, NARA, classification and release
-- dates). Take a backup or an export first if those matter.

DROP TABLE IF EXISTS source_government_record;
