-- 0015_published_builds (down)
--
-- Rolling back withdraws every published download and forgets what each build
-- was assembled from. That is the safe direction: after this runs there is no
-- public download route to serve anything, and the compiled files themselves
-- are untouched in storage, still reachable by an administrator.

DROP TABLE IF EXISTS manuscript_build_item;
DROP TABLE IF EXISTS manuscript_published_build;
