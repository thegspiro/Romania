-- 0002_init_content (down)
--
-- Reverse dependency order. content_item is last because every detail table
-- and every cross-reference table points at it.

DROP TABLE IF EXISTS content_tag;
DROP TABLE IF EXISTS tag;
DROP TABLE IF EXISTS citation;
DROP TABLE IF EXISTS relationship;
DROP TABLE IF EXISTS relationship_predicate;
DROP TABLE IF EXISTS event_detail;
DROP TABLE IF EXISTS place_detail;
DROP TABLE IF EXISTS agent_detail;
DROP TABLE IF EXISTS essay_detail;
DROP TABLE IF EXISTS artifact_detail;
DROP TABLE IF EXISTS source_detail;
DROP TABLE IF EXISTS file_derivative;
DROP TABLE IF EXISTS file_object;
DROP TABLE IF EXISTS content_item;
