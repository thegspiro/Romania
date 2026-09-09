"""Database and file backups.

This site is the working copy of several years of research. The container is
replaceable; the data is not. So the backup job writes a compressed dump and a
file archive to a directory that is expected to be a mounted share on the
host, outside the container's own storage.

The database password is passed to mysqldump through a defaults file with
0600 permissions, never on the command line: arguments are visible to every
process on the host through /proc.
"""

from __future__ import annotations

import gzip
import logging
import os
import shutil
import subprocess
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pymysql

from worker.config import Config

LOGGER = logging.getLogger("worker.backup")

MYSQLDUMP_TIMEOUT_SECONDS = 3600
DEFAULT_KEEP = 14


def run(
    _connection: pymysql.connections.Connection,
    config: Config,
    payload: dict[str, Any],
) -> None:
    keep = payload.get("keep", DEFAULT_KEEP)
    if not isinstance(keep, int) or not 1 <= keep <= 365:
        raise ValueError("payload.keep must be an integer between 1 and 365")

    include_files = bool(payload.get("includeFiles", True))

    config.backup_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")

    dump_path = _dump_database(config, stamp)
    LOGGER.info("wrote database backup %s (%s bytes)", dump_path.name, dump_path.stat().st_size)

    if include_files and config.storage_root.is_dir():
        archive_path = _archive_files(config, stamp)
        LOGGER.info(
            "wrote file backup %s (%s bytes)", archive_path.name, archive_path.stat().st_size
        )

    removed = _prune(config.backup_root, keep)
    if removed:
        LOGGER.info("pruned %s old backup file(s)", removed)


def _dump_database(config: Config, stamp: str) -> Path:
    target = config.backup_root / f"database-{stamp}.sql.gz"
    partial = target.with_suffix(".partial")

    # mkstemp creates the file with 0600 before anything is written to it, so
    # the password is never briefly world-readable.
    handle, defaults_path = tempfile.mkstemp(prefix="dsp-dump-", suffix=".cnf")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as defaults:
            defaults.write("[client]\n")
            defaults.write(f"user={config.db_user}\n")
            defaults.write(f"password={config.db_password}\n")
            defaults.write(f"host={config.db_host}\n")
            defaults.write(f"port={config.db_port}\n")

        command = [
            "mysqldump",
            f"--defaults-extra-file={defaults_path}",
            # A consistent snapshot without locking the site out for the
            # duration; every table is InnoDB.
            "--single-transaction",
            "--quick",
            "--routines",
            "--triggers",
            "--events",
            "--default-character-set=utf8mb4",
            "--hex-blob",
            # The dump is restored into a database created by the deployment,
            # so it must not carry its own CREATE DATABASE.
            "--no-create-db",
            config.db_name,
        ]

        # No shell: the argument list goes straight to execve, so nothing in
        # the configuration can be interpreted as a shell metacharacter.
        with gzip.open(partial, "wb") as compressed:
            process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert process.stdout is not None
            shutil.copyfileobj(process.stdout, compressed)
            process.stdout.close()
            stderr = process.stderr.read() if process.stderr else b""
            returncode = process.wait(timeout=MYSQLDUMP_TIMEOUT_SECONDS)

        if returncode != 0:
            partial.unlink(missing_ok=True)
            raise RuntimeError(
                f"mysqldump exited {returncode}: {stderr.decode('utf-8', 'replace').strip()}"
            )
    finally:
        Path(defaults_path).unlink(missing_ok=True)

    # Rename only after a complete, successful dump, so a partial file is
    # never mistaken for a usable backup.
    partial.replace(target)
    target.chmod(0o600)
    return target


def _archive_files(config: Config, stamp: str) -> Path:
    target = config.backup_root / f"files-{stamp}.tar.gz"
    partial = target.with_suffix(".partial")

    with tarfile.open(partial, "w:gz") as archive:
        archive.add(config.storage_root, arcname="files", recursive=True)

    partial.replace(target)
    target.chmod(0o600)
    return target


def _prune(directory: Path, keep: int) -> int:
    """Keeps the newest `keep` of each backup kind."""
    removed = 0
    for prefix in ("database-", "files-"):
        candidates = sorted(
            (path for path in directory.glob(f"{prefix}*") if path.is_file()),
            key=lambda path: path.name,
            reverse=True,
        )
        for stale in candidates[keep:]:
            stale.unlink(missing_ok=True)
            removed += 1
    return removed
