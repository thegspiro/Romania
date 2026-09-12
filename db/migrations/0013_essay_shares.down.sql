-- 0013_essay_shares (down)
--
-- Drops the links and the feedback that came through them.
--
-- The comments are the loss here: they are a supervisor's words, typed once,
-- and derivable from nothing else in the schema. The essays they were written
-- about are untouched. Take a dump first if a review is in progress.
--
-- Dropping the links is not itself a disclosure risk -- quite the opposite.
-- Once this table is gone no token resolves, so every issued link stops
-- working immediately, which is the safe direction for a rollback to fail in.

DROP TABLE IF EXISTS essay_share_comment;
DROP TABLE IF EXISTS essay_share;
