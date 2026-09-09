-- 0003_init_jobs_audit (up)
--
-- Background work queue and the audit trail.
--
-- The queue is a table rather than Redis or RabbitMQ: it is one fewer service
-- to run on Unraid, and enqueueing a job commits in the same transaction as
-- the row that caused it, so a job can never reference data that was rolled
-- back. Workers claim rows with SELECT ... FOR UPDATE SKIP LOCKED, which lets
-- several workers run without ever handing the same job to two of them.

CREATE TABLE IF NOT EXISTS job (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind          VARCHAR(64)     NOT NULL,
  payload       JSON            NOT NULL,
  state         ENUM('pending', 'running', 'succeeded', 'failed')
                                NOT NULL DEFAULT 'pending',
  attempts      INT UNSIGNED    NOT NULL DEFAULT 0,
  max_attempts  INT UNSIGNED    NOT NULL DEFAULT 5,
  -- Retry backoff and scheduled work both express themselves as a future
  -- run_after; the claim query simply never sees the row until then.
  run_after     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_by     VARCHAR(64)     NULL,
  locked_at     DATETIME(3)     NULL,
  last_error    TEXT            NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Exactly the claim query's access path: state, then due time, then id.
  KEY ix_job_claim (state, run_after, id),
  KEY ix_job_kind (kind, state),
  -- Detects workers that died holding a lock, so their jobs can be released.
  KEY ix_job_locked (locked_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Username, or 'cli' / 'worker' for non-interactive actors.
  actor       VARCHAR(190)    NOT NULL,
  -- 'source.create', 'content.publish', 'auth.login.success', ...
  action      VARCHAR(64)     NOT NULL,
  -- Intentionally NOT a foreign key: the audit trail must outlive the row it
  -- describes, and the most interesting entries are deletions.
  item_id     BIGINT UNSIGNED NULL,
  detail      JSON            NULL,
  ip_address  VARBINARY(16)   NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_log_created (created_at),
  KEY ix_audit_log_item (item_id),
  KEY ix_audit_log_action (action, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
