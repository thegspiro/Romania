"""Rendering an assembled manuscript with Pandoc.

This handler is deliberately thin. The web application has already walked the
outline, applied the visibility filter, demoted headings and rewritten
references into Pandoc syntax; it left a Markdown file and a CSL-JSON
bibliography in the build's staging directory. Everything this module does is
run Pandoc over them and store the result.

That division matters. Re-implementing reference parsing here would duplicate
it across two languages, and re-implementing the visibility filter would put a
second copy of the rule outside the chokepoint CLAUDE.md requires it to live
in. The safest worker is one that makes no decisions about who may see what.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import pymysql

from worker.config import Config
from worker.db import fetch_one, transaction
from worker.storage import resolve

LOGGER = logging.getLogger("worker.manuscript")

PANDOC_TIMEOUT_SECONDS = 900

# Output format -> (pandoc writer, file extension, MIME type)
FORMATS: dict[str, tuple[str, str, str]] = {
    "pdf": ("pdf", "pdf", "application/pdf"),
    "docx": ("docx", "docx",
             "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "html": ("html5", "html", "text/html"),
    "latex": ("latex", "tex", "application/x-tex"),
    "markdown": ("markdown", "md", "text/markdown"),
}

# Vendored with the application, so citations render identically here and on
# the web pages.
CSL_STYLE = Path(__file__).resolve().parents[2] / "dist" / "citations" / "styles" / \
    "chicago-notes-bibliography.csl"
CSL_STYLE_FALLBACK = Path(__file__).resolve().parents[2] / "src" / "citations" / "styles" / \
    "chicago-notes-bibliography.csl"


class CompileError(RuntimeError):
    """Pandoc could not produce the document."""


def _style_path() -> Path:
    """The compiled tree is preferred; the source tree is the dev fallback."""
    if CSL_STYLE.is_file():
        return CSL_STYLE
    if CSL_STYLE_FALLBACK.is_file():
        return CSL_STYLE_FALLBACK
    raise CompileError("The Chicago CSL style is missing from the image.")


def run(
    connection: pymysql.connections.Connection,
    config: Config,
    payload: dict[str, Any],
) -> None:
    build_id = payload.get("buildId")
    # bool is a subclass of int, so `isinstance(x, int)` alone would let
    # `true` through and put "builds/True" into a storage path.
    if not isinstance(build_id, int) or isinstance(build_id, bool) or build_id <= 0:
        raise ValueError("payload.buildId must be a positive integer")

    build = fetch_one(
        connection,
        """
        SELECT id, manuscript_item_id, format, audience, state
          FROM manuscript_build
         WHERE id = %s
        """,
        (build_id,),
    )
    if build is None:
        LOGGER.info("build %s no longer exists, skipping", build_id)
        return

    fmt = str(build["format"])
    if fmt not in FORMATS:
        raise ValueError(f"unknown build format {fmt!r}")

    _mark_running(connection, build_id)

    try:
        stored = _compile(config, build_id, fmt)
    except Exception as error:  # noqa: BLE001 - recorded on the build, then re-raised
        _mark_failed(connection, build_id, str(error))
        raise

    _mark_succeeded(connection, build_id, stored)
    LOGGER.info("build %s produced %s (%s bytes)", build_id, fmt, stored["byte_size"])


def _compile(config: Config, build_id: int, fmt: str) -> dict[str, Any]:
    writer, extension, mime_type = FORMATS[fmt]

    document = resolve(config.storage_root, f"builds/{build_id}/document.md")
    references = resolve(config.storage_root, f"builds/{build_id}/references.json")
    if not document.is_file():
        raise CompileError(f"assembled document missing at {document}")

    with tempfile.TemporaryDirectory(prefix=f"dsp-build-{build_id}-") as workspace:
        output = Path(workspace) / f"manuscript.{extension}"

        command = [
            "pandoc",
            str(document),
            # header_attributes is what turns the assembler's {#sec-...} into
            # real cross-reference targets.
            "--from=markdown+header_attributes+fenced_code_attributes",
            f"--to={writer}",
            f"--output={output}",
            "--standalone",
            "--citeproc",
            f"--csl={_style_path()}",
            "--resource-path",
            str(document.parent),
        ]

        if references.is_file() and references.stat().st_size > 2:
            command.append(f"--bibliography={references}")

        if fmt == "pdf":
            # Tectonic fetches only the TeX packages a document actually uses,
            # rather than shipping a multi-gigabyte TeX Live.
            command.append("--pdf-engine=tectonic")

        LOGGER.info("running pandoc for build %s -> %s", build_id, fmt)
        # No shell: the argument list goes straight to execve, so nothing in a
        # title or a path can be read as a shell metacharacter.
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            command,
            capture_output=True,
            timeout=PANDOC_TIMEOUT_SECONDS,
            check=False,
        )

        log = completed.stderr.decode("utf-8", "replace").strip()
        if completed.returncode != 0:
            raise CompileError(f"pandoc exited {completed.returncode}: {log[:4000]}")
        if not output.is_file():
            raise CompileError("pandoc reported success but produced no file")

        contents = output.read_bytes()
        sha256 = hashlib.sha256(contents).hexdigest()
        storage_key = f"files/{sha256[0:2]}/{sha256[2:4]}/{sha256}"
        destination = resolve(config.storage_root, storage_key)
        destination.parent.mkdir(parents=True, exist_ok=True)

        # Copy to a temporary name in the destination directory and rename, so
        # a crash mid-copy cannot leave a truncated file at the address its
        # hash promises.
        partial = destination.with_suffix(destination.suffix + ".partial")
        shutil.copyfile(output, partial)
        partial.replace(destination)

        return {
            "sha256": sha256,
            "byte_size": len(contents),
            "mime_type": mime_type,
            "storage_key": storage_key,
            "filename": f"manuscript.{extension}",
            "log": log,
        }


def _mark_running(connection: pymysql.connections.Connection, build_id: int) -> None:
    with transaction(connection) as cursor:
        cursor.execute(
            "UPDATE manuscript_build SET state = 'running' WHERE id = %s",
            (build_id,),
        )


def _mark_succeeded(
    connection: pymysql.connections.Connection,
    build_id: int,
    stored: dict[str, Any],
) -> None:
    with transaction(connection) as cursor:
        # Content-addressed: identical bytes reuse the existing row rather
        # than colliding on the unique key.
        cursor.execute("SELECT id FROM file_object WHERE sha256 = %s", (stored["sha256"],))
        existing = cursor.fetchone()

        if existing is None:
            cursor.execute(
                """
                INSERT INTO file_object
                  (sha256, byte_size, mime_type, original_filename, storage_key)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    stored["sha256"],
                    stored["byte_size"],
                    stored["mime_type"],
                    stored["filename"],
                    stored["storage_key"],
                ),
            )
            file_object_id = cursor.lastrowid
        else:
            file_object_id = existing["id"]

        cursor.execute(
            """
            UPDATE manuscript_build
               SET state = 'succeeded', file_object_id = %s, log = %s, finished_at = NOW(3)
             WHERE id = %s
            """,
            (file_object_id, stored["log"][:60000] or None, build_id),
        )


def _mark_failed(
    connection: pymysql.connections.Connection,
    build_id: int,
    message: str,
) -> None:
    # The runner will retry, but the operator should be able to read what went
    # wrong without waiting for the attempts to be exhausted.
    connection.rollback()
    with transaction(connection) as cursor:
        cursor.execute(
            """
            UPDATE manuscript_build
               SET state = 'failed', log = %s, finished_at = NOW(3)
             WHERE id = %s
            """,
            (message[:60000], build_id),
        )
