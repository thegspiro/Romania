-- 0010_essay_revisions (down)
--
-- Drops the history. The essays themselves are untouched -- `essay_detail`
-- still holds the current text of every one of them, because a revision is a
-- copy of what was saved and never the only copy.
--
-- Rolling back does lose the earlier versions, which is the one thing this
-- table exists to keep. There is nowhere else to put them: they are not
-- derivable from the current text. Take a dump first if the history matters.

DROP TABLE IF EXISTS essay_revision;
