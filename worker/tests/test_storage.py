"""Storage path handling.

A traversal in `file_object.storage_key` would let a background job read or
overwrite arbitrary files inside the container, so `resolve` is the only way
this codebase turns a stored key into a path and it refuses anything that is
not a plain relative path under the storage root.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from worker.storage import UnsafeStorageKey, derivative_key, resolve

ROOT = Path("/data/files")
SHA = "a" * 64


class TestResolve:
    def test_accepts_a_plain_key(self) -> None:
        assert resolve(ROOT, "ab/cd/file.jpg") == Path("/data/files/ab/cd/file.jpg")

    @pytest.mark.parametrize(
        "key",
        [
            "../etc/passwd",
            "ab/../../etc/passwd",
            "/etc/passwd",
            "..",
            "ab/../..",
        ],
    )
    def test_refuses_traversal(self, key: str) -> None:
        with pytest.raises(UnsafeStorageKey):
            resolve(ROOT, key)

    @pytest.mark.parametrize("key", ["", "ab/cd/$(whoami)", "ab;rm -rf /", "ab\x00cd", "ab cd"])
    def test_refuses_anything_outside_the_allowed_alphabet(self, key: str) -> None:
        with pytest.raises(UnsafeStorageKey):
            resolve(ROOT, key)

    def test_refuses_an_over_long_key(self) -> None:
        with pytest.raises(UnsafeStorageKey):
            resolve(ROOT, "a" * 300)


class TestDerivativeKey:
    def test_shards_two_levels_deep(self) -> None:
        # No single directory should accumulate every file; listings and
        # backups degrade badly when one does.
        key = derivative_key(SHA, "thumb", "jpg")
        assert key == f"derivatives/thumb/aa/aa/{SHA}.jpg"
        # And it must survive its own resolver.
        assert resolve(ROOT, key).is_relative_to(ROOT)

    def test_rejects_a_non_hex_digest(self) -> None:
        with pytest.raises(UnsafeStorageKey):
            derivative_key("not-a-digest", "thumb", "jpg")
        with pytest.raises(UnsafeStorageKey):
            derivative_key("A" * 64, "thumb", "jpg")  # uppercase is not our format

    def test_rejects_an_unsafe_variant_or_extension(self) -> None:
        with pytest.raises(UnsafeStorageKey):
            derivative_key(SHA, "../escape", "jpg")
        with pytest.raises(UnsafeStorageKey):
            derivative_key(SHA, "thumb", "jpg/../..")
