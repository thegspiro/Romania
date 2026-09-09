"""File storage paths.

Files are addressed by the content hash recorded in `file_object.storage_key`,
never by anything a user typed. `resolve` is the only way this codebase turns
a stored key into a path, and it refuses any key that would escape the storage
root -- a traversal in that column would otherwise let a job read or overwrite
arbitrary files in the container.
"""

from __future__ import annotations

import re
from pathlib import Path

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
