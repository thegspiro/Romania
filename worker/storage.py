"""File storage paths.

Files are addressed by the content hash recorded in `file_object.storage_key`,
never by anything a user typed. `resolve` is the only way this codebase turns
a stored key into a path, and it refuses any key that would escape the storage
root -- a traversal in that column would otherwise let a job read or overwrite
arbitrary files in the container.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

# Keys are generated from hex digests, so this is deliberately narrow.
SAFE_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$")


class UnsafeStorageKey(ValueError):
    """Raised when a storage key is not a plain relative path."""


def resolve(root: Path, key: str) -> Path:
    """Turns a storage key into an absolute path inside `root`."""
    if not SAFE_KEY.match(key):
        raise UnsafeStorageKey(f"refusing unsafe storage key {key!r}")
    if key.startswith("/") or ".." in key.split("/"):
        raise UnsafeStorageKey(f"refusing unsafe storage key {key!r}")

    candidate = (root / key).resolve()
    root_resolved = root.resolve()
    # Belt and braces: even with the pattern above, confirm containment after
    # symlink resolution.
    if not candidate.is_relative_to(root_resolved):
        raise UnsafeStorageKey(f"storage key {key!r} escapes the storage root")
    return candidate


def original_key(sha256: str) -> str:
    """Key for a stored original. Matches `originalKey` in src/files/storage.ts.

    Sharded two levels deep so no single directory accumulates every file.
    """
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise UnsafeStorageKey(f"expected a hex sha256, got {sha256!r}")
    return f"files/{sha256[0:2]}/{sha256[2:4]}/{sha256}"


def derivative_key(sha256: str, variant: str, extension: str) -> str:
    """Key for a generated derivative.

    Sharded two levels deep so no single directory accumulates every file;
    ext4 copes, but directory listings and backups do not.
    """
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise UnsafeStorageKey(f"expected a hex sha256, got {sha256!r}")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", variant):
        raise UnsafeStorageKey(f"refusing unsafe variant {variant!r}")
    if not re.fullmatch(r"[a-z0-9]{1,8}", extension):
        raise UnsafeStorageKey(f"refusing unsafe extension {extension!r}")

    return f"derivatives/{variant}/{sha256[0:2]}/{sha256[2:4]}/{sha256}.{extension}"


# --- Backends --------------------------------------------------------------
#
# The mirror of `src/files/backend.ts`. Both sides address the same keys, so a
# derivative this worker writes is the object the web service serves, whichever
# backend is configured. They must stay in step: `tests/fixtures/storage-keys
# .json` holds the cases both suites read, so a key shape cannot drift here
# while staying green there.
#
# The worker deliberately does NOT fetch bytes straight into Pillow or Pandoc
# from an object store. Both want a real file -- Pandoc needs a path it can
# hand to a resource loader, Pillow seeks within the file it opens -- so a job
# fetches to a temporary directory, works there, and puts the result back. That
# keeps every tool in the worker unaware that storage has a backend at all.


class StorageObjectNotFound(FileNotFoundError):
    """Raised when a key names nothing. Callers turn it into a job failure."""


class Backend:
    """Where file bytes live."""

    kind: str

    def describe(self) -> str:
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def read_bytes(self, key: str) -> bytes:
        raise NotImplementedError

    def fetch_to_file(self, key: str, destination: Path) -> Path:
        """Puts the object's bytes in a local file and returns its path."""
        raise NotImplementedError

    def put_file(self, key: str, source: Path) -> None:
        raise NotImplementedError

    def put_bytes(self, key: str, contents: bytes) -> None:
        raise NotImplementedError


class LocalBackend(Backend):
    kind = "local"

    def __init__(self, root: Path) -> None:
        self._root = root

    def describe(self) -> str:
        return f"local directory {self._root}"

    def exists(self, key: str) -> bool:
        return resolve(self._root, key).is_file()

    def read_bytes(self, key: str) -> bytes:
        path = resolve(self._root, key)
        if not path.is_file():
            raise StorageObjectNotFound(key)
        return path.read_bytes()

    def fetch_to_file(self, key: str, destination: Path) -> Path:
        path = resolve(self._root, key)
        if not path.is_file():
            raise StorageObjectNotFound(key)
        # Already a local file: hand back the real path rather than copying it.
        return path

    def put_file(self, key: str, source: Path) -> None:
        target = resolve(self._root, key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Temporary name then rename, so a crash mid-write cannot leave
        # truncated bytes at the address a content hash promises.
        partial = target.with_name(target.name + ".partial")
        shutil.copyfile(source, partial)
        partial.replace(target)

    def put_bytes(self, key: str, contents: bytes) -> None:
        target = resolve(self._root, key)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        partial.write_bytes(contents)
        partial.replace(target)


class S3Backend(Backend):
    kind = "s3"

    def __init__(self, client: Any, bucket: str, prefix: str) -> None:
        self._client = client
        self._bucket = bucket
        self._prefix = prefix

    def describe(self) -> str:
        under = "" if self._prefix == "" else f" under {self._prefix}"
        return f"s3 bucket {self._bucket}{under}"

    def _object_key(self, key: str) -> str:
        # The same rule the local backend enforces. Traversal cannot escape a
        # bucket, but a key nothing else can address is still a bug, and a
        # rule applied to one backend and not the other is the kind that rots.
        if not SAFE_KEY.match(key) or key.startswith("/") or ".." in key.split("/"):
            raise UnsafeStorageKey(f"refusing unsafe storage key {key!r}")
        return f"{self._prefix}{key}"

    def _is_missing(self, error: Exception) -> bool:
        response = getattr(error, "response", None)
        if not isinstance(response, dict):
            return False
        code = str(response.get("Error", {}).get("Code", ""))
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return code in ("404", "NoSuchKey", "NotFound") or status == 404

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=self._bucket, Key=self._object_key(key))
            return True
        except ClientError as error:
            if self._is_missing(error):
                return False
            raise

    def read_bytes(self, key: str) -> bytes:
        from botocore.exceptions import ClientError

        try:
            response = self._client.get_object(Bucket=self._bucket, Key=self._object_key(key))
        except ClientError as error:
            if self._is_missing(error):
                raise StorageObjectNotFound(key) from error
            raise
        body: bytes = response["Body"].read()
        return body

    def fetch_to_file(self, key: str, destination: Path) -> Path:
        from botocore.exceptions import ClientError

        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._client.download_file(self._bucket, self._object_key(key), str(destination))
        except ClientError as error:
            if self._is_missing(error):
                raise StorageObjectNotFound(key) from error
            raise
        return destination

    def put_file(self, key: str, source: Path) -> None:
        self._client.upload_file(str(source), self._bucket, self._object_key(key))

    def put_bytes(self, key: str, contents: bytes) -> None:
        self._client.put_object(Bucket=self._bucket, Key=self._object_key(key), Body=contents)


def create_backend(config: Any) -> Backend:
    """The backend this configuration asks for."""
    if config.storage_backend == "local":
        return LocalBackend(config.storage_root)

    import boto3

    # Credentials are left to boto3's own chain when none are configured, so an
    # instance role works without a long-lived key in the environment.
    credentials: dict[str, str] = {}
    if config.s3_access_key_id and config.s3_secret_access_key:
        credentials = {
            "aws_access_key_id": config.s3_access_key_id,
            "aws_secret_access_key": config.s3_secret_access_key,
        }

    from botocore.config import Config as BotoConfig

    addressing = "path" if config.s3_force_path_style else "auto"
    client = boto3.client(
        "s3",
        region_name=config.s3_region,
        endpoint_url=config.s3_endpoint or None,
        config=BotoConfig(s3={"addressing_style": addressing}),
        **credentials,
    )
    return S3Backend(client, config.s3_bucket, config.s3_prefix)
