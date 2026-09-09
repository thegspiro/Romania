-- 0001_init_auth (up)
--
-- Single-administrator authentication: an Argon2id password as the first
-- factor, WebAuthn passkeys as the second, single-use recovery codes as the
-- break-glass path, and server-side sessions.
--
-- Statements use IF NOT EXISTS because MySQL performs an implicit commit
-- around DDL: a migration that fails partway cannot be rolled back, so
-- re-running it after fixing the cause must be safe.

CREATE TABLE IF NOT EXISTS admin_user (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username              VARCHAR(64)     NOT NULL,
  display_name          VARCHAR(190)    NOT NULL,
  -- Argon2id PHC string; the encoded parameters travel with the hash so
  -- raising the cost later does not invalidate existing passwords.
  password_hash         VARCHAR(255)    NOT NULL,
  -- Opaque, stable WebAuthn user handle. Deliberately not the username or the
  -- primary key: the spec requires a handle that carries no personal data,
  -- and authenticators store it verbatim.
  webauthn_user_handle  BINARY(32)      NOT NULL,
  password_changed_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The accent- and case-insensitive collation means "Admin" and "admin"
  -- cannot both be registered, which is what we want for a login identifier.
  UNIQUE KEY uq_admin_user_username (username),
  UNIQUE KEY uq_admin_user_webauthn_handle (webauthn_user_handle)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS webauthn_credential (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  -- Raw credential ID bytes as returned by the authenticator. Stored binary
  -- rather than base64url so equality comparison is unambiguous.
  credential_id   VARBINARY(255)  NOT NULL,
  public_key      VARBINARY(1024) NOT NULL,
  sign_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- Comma-separated transport hints ("usb,nfc,hybrid,internal"). Advisory
  -- only: they help the browser show the right prompt.
  transports      VARCHAR(255)    NULL,
  aaguid          BINARY(16)      NULL,
  -- True when the credential is synced to a provider's cloud (Bitwarden,
  -- iCloud Keychain, Google Password Manager). Surfaced in the UI so the
  -- operator can tell a synced passkey from a hardware-bound one.
  backed_up       TINYINT(1)      NOT NULL DEFAULT 0,
  device_type     VARCHAR(32)     NOT NULL DEFAULT 'singleDevice',
  -- Operator-chosen name, e.g. "Bitwarden" or "YubiKey 5C".
  label           VARCHAR(190)    NOT NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webauthn_credential_credential_id (credential_id),
  KEY ix_webauthn_credential_user (user_id),
  CONSTRAINT fk_webauthn_credential_user
    FOREIGN KEY (user_id) REFERENCES admin_user (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS recovery_code (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  code_hash   VARCHAR(255)    NOT NULL,
  used_at     DATETIME(3)     NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_recovery_code_user_unused (user_id, used_at),
  CONSTRAINT fk_recovery_code_user
    FOREIGN KEY (user_id) REFERENCES admin_user (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS session (
  -- Hex SHA-256 of the session token. The token itself is only ever in the
  -- cookie: a database leak must not hand an attacker live sessions.
  id            CHAR(64)        NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  csrf_token    CHAR(64)        NOT NULL,
  -- Two-step login lives here rather than in a side channel: a session that
  -- has passed the password but not yet the passkey is 'password_pending'
  -- and is refused by every authenticated route.
  auth_state    ENUM('password_pending', 'authenticated') NOT NULL DEFAULT 'password_pending',
  -- Packed binary address (4 bytes IPv4, 16 bytes IPv6) via INET6_ATON.
  ip_address    VARBINARY(16)   NULL,
  user_agent    VARCHAR(255)    NULL,
  -- The in-flight WebAuthn challenge, base64url encoded. A ceremony spans two
  -- requests (options, then verification) and the challenge issued by the
  -- first must be the one checked by the second. Binding it to the session
  -- means a challenge cannot be replayed from another browser, and it is
  -- cleared as soon as the ceremony ends, successfully or not.
  webauthn_challenge            VARCHAR(255) NULL,
  webauthn_challenge_expires_at DATETIME(3)  NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_session_user (user_id),
  KEY ix_session_expires (expires_at),
  CONSTRAINT fk_session_user
    FOREIGN KEY (user_id) REFERENCES admin_user (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS login_attempt (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Username as typed. Recorded even when no such user exists, so that
  -- guessing usernames is throttled too.
  identifier    VARCHAR(190)    NOT NULL,
  ip_address    VARBINARY(16)   NULL,
  successful    TINYINT(1)      NOT NULL DEFAULT 0,
  attempted_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_login_attempt_identifier (identifier, attempted_at),
  KEY ix_login_attempt_ip (ip_address, attempted_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
