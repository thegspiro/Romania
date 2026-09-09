-- 0001_init_auth (down)
--
-- Dropped in reverse dependency order so foreign keys never block the drop.

DROP TABLE IF EXISTS login_attempt;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS recovery_code;
DROP TABLE IF EXISTS webauthn_credential;
DROP TABLE IF EXISTS admin_user;
