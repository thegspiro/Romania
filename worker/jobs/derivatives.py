"""Image and PDF derivatives.

Archival scans are routinely 40 MB TIFFs and 300 MB PDFs. Serving those to a
browser is not an option, so every uploaded file gets a web-sized rendition
and a thumbnail generated here.

Two things matter beyond resizing:

  * EXIF is dropped. Photographs taken in an archive or a private home carry
    GPS coordinates and camera serial numbers, and publishing those alongside
    research about named people is a disclosure nobody intended. Pillow only
    writes EXIF when explicitly asked, so this is a matter of not asking --
    but the orientation tag is applied first, or portrait scans come out
    sideways once the tag is gone.
  * The work is idempotent. A retry regenerates the same derivative and
    replaces the row, because a handler can be re-run after a partial failure.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pymysql
from PIL import Image, ImageOps

from worker.config import Config
from worker.db import fetch_one, transaction
from worker.storage import derivative_key, resolve

LOGGER = logging.getLogger("worker.derivatives")

# Pillow refuses images above a pixel budget to avoid decompression bombs.
# Archival scans are legitimately large, so the limit is raised deliberately
# rather than disabled: 300 megapixels is far beyond any real scan and still
# bounds the memory a hostile file can demand.
Image.MAX_IMAGE_PIXELS = 300_000_000

VARIANTS: dict[str, int] = {
    "thumb": 400,
    "web": 1600,
}

IMAGE_MIME_PREFIX = "image/"
PDF_MIME = "application/pdf"


def run(
    connection: pymysql.connections.Connection,
    config: Config,
    payload: dict[str, Any],
) -> None:
    file_object_id = payload.get("fileObjectId")
    if not isinstance(file_object_id, int):
        raise ValueError("payload.fileObjectId must be an integer")

    record = fetch_one(
        connection,
        "SELECT id, sha256, mime_type, storage_key FROM file_object WHERE id = %s",
        (file_object_id,),
    )
    if record is None:
        # The file was deleted between enqueue and execution. Nothing to do,
        # and failing would retry forever.
        LOGGER.info("file_object %s no longer exists, skipping", file_object_id)
        return

    source_path = resolve(config.storage_root, str(record["storage_key"]))
    if not source_path.is_file():
        raise FileNotFoundError(f"stored file missing at {source_path}")

    mime = str(record["mime_type"])
    sha256 = str(record["sha256"])

    if mime.startswith(IMAGE_MIME_PREFIX):
        with Image.open(source_path) as image:
            _write_variants(connection, config, file_object_id, sha256, image)
    elif mime == PDF_MIME:
        _render_pdf_first_page(connection, config, file_object_id, sha256, source_path)
    else:
        LOGGER.info("no derivative rule for mime type %s (file %s)", mime, file_object_id)


def _write_variants(
    connection: pymysql.connections.Connection,
    config: Config,
    file_object_id: int,
    sha256: str,
    image: Image.Image,
) -> None:
    # Apply the orientation tag while it is still present, then work from
    # pixels only.
    oriented = ImageOps.exif_transpose(image) or image
    if oriented.mode not in ("RGB", "L"):
        oriented = oriented.convert("RGB")

    for variant, longest_edge in VARIANTS.items():
        rendition = oriented.copy()
        rendition.thumbnail((longest_edge, longest_edge), Image.Resampling.LANCZOS)

        key = derivative_key(sha256, variant, "jpg")
        target = resolve(config.storage_root, key)
        target.parent.mkdir(parents=True, exist_ok=True)

        # Write to a temporary file and rename, so a crash mid-write cannot
        # leave a truncated image that later looks valid.
        temporary = target.with_suffix(".tmp")
        rendition.save(temporary, format="JPEG", quality=82, optimize=True, progressive=True)
        temporary.replace(target)

        _record_derivative(
            connection,
            file_object_id=file_object_id,
            variant=variant,
            mime_type="image/jpeg",
            width=rendition.width,
            height=rendition.height,
            byte_size=target.stat().st_size,
            storage_key=key,
        )
        LOGGER.info("wrote %s derivative for file %s", variant, file_object_id)


def _render_pdf_first_page(
    connection: pymysql.connections.Connection,
    config: Config,
    file_object_id: int,
    sha256: str,
    source_path: Path,
) -> None:
    # Imported lazily: a deployment that never handles PDFs should not pay for
    # loading the native library at worker start.
    import pypdfium2

    document = pypdfium2.PdfDocument(source_path)
    try:
        if len(document) == 0:
            LOGGER.warning("pdf %s has no pages", file_object_id)
            return
        page = document[0]
        # scale 2 gives roughly 144 dpi, enough to read a title page.
        bitmap = page.render(scale=2)
        image = bitmap.to_pil()
        try:
            _write_variants(connection, config, file_object_id, sha256, image)
        finally:
            image.close()
    finally:
        document.close()


def _record_derivative(
    connection: pymysql.connections.Connection,
    *,
    file_object_id: int,
    variant: str,
    mime_type: str,
    width: int,
    height: int,
    byte_size: int,
    storage_key: str,
) -> None:
    with transaction(connection) as cursor:
        # ON DUPLICATE KEY makes regeneration idempotent: the unique key is
        # (file_object_id, variant).
        cursor.execute(
            """
            INSERT INTO file_derivative
              (file_object_id, variant, mime_type, width, height, byte_size, storage_key)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              mime_type = VALUES(mime_type),
              width = VALUES(width),
              height = VALUES(height),
              byte_size = VALUES(byte_size),
              storage_key = VALUES(storage_key)
            """,
            (file_object_id, variant, mime_type, width, height, byte_size, storage_key),
        )
