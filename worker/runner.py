"""Background job runner.

The queue is a MySQL table. Jobs are claimed with

    SELECT ... FOR UPDATE SKIP LOCKED

which hands each row to exactly one worker and lets the others move on
instead of blocking. That is the whole reason there is no Redis here: one
fewer service to run, and enqueuing a job commits in the same transaction as
the data that caused it, so a job can never reference a row that was rolled
back.

Failures are retried with exponential backoff by pushing `run_after` into the
future; the claim query simply does not see the row until then. After
`max_attempts` the job is marked failed and left in place for inspection --
silently dropping it would lose the only record that something went wrong.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import signal
import socket
import sys
import time
from collections.abc import Callable
from types import FrameType
from typing import Any

import pymysql

from worker.config import Config, ConfigError, load_config
from worker.db import connect, transaction
from worker.jobs import backup, bibliography_import, derivatives, geocode

LOGGER = logging.getLogger("worker")

JobHandler = Callable[[pymysql.connections.Connection, Config, dict[str, Any]], None]

# Adding a job kind means adding it here and nowhere else.
HANDLERS: dict[str, JobHandler] = {
    "file.derivatives": derivatives.run,
    "bibliography.import": bibliography_import.run,
    "place.geocode": geocode.run,
    "backup.run": backup.run,
}

MAX_BACKOFF_SECONDS = 3600


class Runner:
    def __init__(self, config: Config) -> None:
        self.config = config
        # Identifies which worker holds a lock, so a stuck job can be traced
        # back to the process that took it.
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"[:64]
        self._stopping = False

    def request_stop(self, signum: int, _frame: FrameType | None) -> None:
        """Finishes the job in hand, then exits. Killing a worker mid-job
        would leave the row locked until the stale-lock sweep releases it."""
        LOGGER.info("received signal %s, finishing current job then stopping", signum)
        self._stopping = True

    # --- Queue operations -------------------------------------------------

    def release_stale_locks(self, connection: pymysql.connections.Connection) -> int:
        """Returns jobs whose worker died to the queue."""
        with transaction(connection) as cursor:
            cursor.execute(
                """
                UPDATE job
                   SET state = 'pending', locked_by = NULL, locked_at = NULL
                 WHERE state = 'running'
                   AND locked_at < NOW(3) - INTERVAL %s MINUTE
                """,
                (self.config.stale_lock_minutes,),
            )
            return cursor.rowcount

    def claim_jobs(self, connection: pymysql.connections.Connection) -> list[dict[str, Any]]:
        with transaction(connection) as cursor:
            cursor.execute(
                """
                SELECT id, kind, payload, attempts, max_attempts
                  FROM job
                 WHERE state = 'pending' AND run_after <= NOW(3)
                 ORDER BY run_after ASC, id ASC
                 LIMIT %s
                 FOR UPDATE SKIP LOCKED
                """,
                (self.config.batch_size,),
            )
            rows = list(cursor.fetchall())
            if not rows:
                return []

            # Marked one at a time rather than with a generated IN (...) list:
            # the batch is at most WORKER_BATCH_SIZE rows, every statement stays
            # fully parameterised, and it is all inside the transaction opened
            # above, so the claim remains atomic.
            for row in rows:
                cursor.execute(
                    """
                    UPDATE job
                       SET state = 'running',
                           locked_by = %s,
                           locked_at = NOW(3),
                           attempts = attempts + 1
                     WHERE id = %s
                    """,
                    (self.worker_id, row["id"]),
                )
            return rows

    def mark_succeeded(self, connection: pymysql.connections.Connection, job_id: int) -> None:
        with transaction(connection) as cursor:
            cursor.execute(
                """
                UPDATE job
                   SET state = 'succeeded', locked_by = NULL, locked_at = NULL, last_error = NULL
                 WHERE id = %s
                """,
                (job_id,),
            )

    def mark_failed(
        self,
        connection: pymysql.connections.Connection,
        job: dict[str, Any],
        error: BaseException,
    ) -> None:
        attempts = int(job["attempts"]) + 1
        max_attempts = int(job["max_attempts"])
        message = f"{type(error).__name__}: {error}"[:4000]

        if attempts >= max_attempts:
            LOGGER.error("job %s (%s) failed permanently: %s", job["id"], job["kind"], message)
            with transaction(connection) as cursor:
                cursor.execute(
                    """
                    UPDATE job
                       SET state = 'failed', locked_by = NULL, locked_at = NULL, last_error = %s
                     WHERE id = %s
                    """,
                    (message, job["id"]),
                )
            return

        delay = min(60 * (2 ** (attempts - 1)), MAX_BACKOFF_SECONDS)
        LOGGER.warning(
            "job %s (%s) failed, retrying in %ss (attempt %s/%s): %s",
            job["id"],
            job["kind"],
            delay,
            attempts,
            max_attempts,
            message,
        )
        with transaction(connection) as cursor:
            cursor.execute(
                """
                UPDATE job
                   SET state = 'pending',
                       locked_by = NULL,
                       locked_at = NULL,
                       last_error = %s,
                       run_after = NOW(3) + INTERVAL %s SECOND
                 WHERE id = %s
                """,
                (message, delay, job["id"]),
            )

    # --- Execution ---------------------------------------------------------

    def run_job(self, connection: pymysql.connections.Connection, job: dict[str, Any]) -> None:
        kind = str(job["kind"])
        handler = HANDLERS.get(kind)
        if handler is None:
            raise ValueError(f"no handler registered for job kind {kind!r}")

        raw_payload = job["payload"]
        payload = json.loads(raw_payload) if isinstance(raw_payload, (str, bytes)) else raw_payload
        if not isinstance(payload, dict):
            raise ValueError(f"job {job['id']} payload is not a JSON object")

        LOGGER.info("running job %s (%s)", job["id"], kind)
        handler(connection, self.config, payload)

    def tick(self, connection: pymysql.connections.Connection) -> int:
        released = self.release_stale_locks(connection)
        if released:
            LOGGER.warning("released %s stale job lock(s)", released)

        jobs = self.claim_jobs(connection)
        for job in jobs:
            try:
                self.run_job(connection, job)
            except Exception as error:  # noqa: BLE001 - the queue must survive any handler
                # Roll back anything the handler left open before recording
                # the failure, or the UPDATE joins the poisoned transaction.
                connection.rollback()
                self.mark_failed(connection, job, error)
            else:
                self.mark_succeeded(connection, job["id"])
        return len(jobs)

    def serve_forever(self) -> int:
        connection = connect(self.config)
        LOGGER.info("worker %s ready", self.worker_id)
        try:
            while not self._stopping:
                try:
                    processed = self.tick(connection)
                except (pymysql.err.OperationalError, pymysql.err.InterfaceError) as error:
                    # The database restarted or the connection dropped.
                    # Reconnect rather than exiting: the container would just
                    # be restarted into the same situation.
                    LOGGER.error("database connection lost (%s), reconnecting", error)
                    with contextlib.suppress(Exception):
                        # Already failing; a close() error tells us nothing new.
                        connection.close()
                    time.sleep(self.config.poll_interval_seconds)
                    connection = connect(self.config)
                    continue

                if processed == 0:
                    # Sleep in short slices so a signal is noticed promptly.
                    for _ in range(self.config.poll_interval_seconds):
                        if self._stopping:
                            break
                        time.sleep(1)
        finally:
            connection.close()
        LOGGER.info("worker %s stopped", self.worker_id)
        return 0


def main() -> int:
    try:
        config = load_config()
    except ConfigError as error:
        sys.stderr.write(f"{error}\n")
        return 78  # EX_CONFIG

    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )

    runner = Runner(config)
    signal.signal(signal.SIGTERM, runner.request_stop)
    signal.signal(signal.SIGINT, runner.request_stop)
    return runner.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
