"""The worker's storage backends.

Storage is the one thing both languages write: this worker writes the
derivatives and compiled documents the web service serves. So the property that
matters is not "S3 works" but that **both backends address the same keys with
the same rules**, and that a key shape cannot drift here while staying green in
the TypeScript suite.

The S3 cases run against moto's in-process AWS mock -- the same tool the
TypeScript suite talks to over HTTP -- rather than a stub of our own, because a
stub proves nothing about how botocore reports a missing object, which is the
branch every caller depends on.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from worker.storage import (
    LocalBackend,
    S3Backend,
    StorageObjectNotFound,
    UnsafeStorageKey,
    create_backend,
    derivative_key,
    original_key,
)

boto3 = pytest.importorskip("boto3")
moto = pytest.importorskip("moto")

BUCKET = "dissertation-test"
KEY = "files/ab/cd/" + "a" * 64

_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "storage-keys.json"
_FIXTURES = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def s3_backend():
    """An S3 backend against an in-process mock, with the bucket created."""
    with moto.mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield S3Backend(client, BUCKET, "")


@pytest.fixture
def local_backend(tmp_path: Path) -> LocalBackend:
    return LocalBackend(tmp_path)


class TestBothBackendsAgree:
    """Every property here has to hold identically on either backend."""

    def test_bytes_round_trip(self, s3_backend, local_backend) -> None:
        for backend in (s3_backend, local_backend):
            backend.put_bytes(KEY, b"archival scan")
            assert backend.read_bytes(KEY) == b"archival scan"
            assert backend.exists(KEY) is True

    def test_a_missing_key_raises_the_same_error(self, s3_backend, local_backend) -> None:
        # Callers turn exactly this into a job failure; a backend raising
        # something else would retry forever instead of reporting.
        for backend in (s3_backend, local_backend):
            assert backend.exists("files/00/00/absent") is False
            with pytest.raises(StorageObjectNotFound):
                backend.read_bytes("files/00/00/absent")

    @pytest.mark.parametrize(
        "key",
        ["../escape", "/absolute", "files/../../etc/passwd", "a" * 300],
    )
    def test_an_unsafe_key_is_refused(self, s3_backend, local_backend, key: str) -> None:
        # Traversal cannot escape a bucket, but a key nothing else can address
        # is still a bug, and a rule enforced on one backend and not the other
        # is the kind that rots quietly.
        for backend in (s3_backend, local_backend):
            with pytest.raises(UnsafeStorageKey):
                backend.put_bytes(key, b"x")

    def test_a_local_file_round_trips(self, s3_backend, local_backend, tmp_path: Path) -> None:
        source = tmp_path / "rendition.jpg"
        source.write_bytes(b"\xff\xd8\xff" + b"x" * 4096)

        for backend in (s3_backend, local_backend):
            backend.put_file(KEY, source)
            assert backend.read_bytes(KEY) == source.read_bytes()

    def test_fetch_to_file_gives_a_readable_path(
        self, s3_backend, local_backend, tmp_path: Path
    ) -> None:
        # Pillow seeks and Pandoc takes paths, so every job works from a real
        # file. With the local backend that is the stored file itself.
        for index, backend in enumerate((s3_backend, local_backend)):
            backend.put_bytes(KEY, b"page one")
            fetched = backend.fetch_to_file(KEY, tmp_path / f"fetched-{index}")
            assert fetched.is_file()
            assert fetched.read_bytes() == b"page one"

    def test_fetch_to_file_reports_a_missing_key(
        self, s3_backend, local_backend, tmp_path: Path
    ) -> None:
        for index, backend in enumerate((s3_backend, local_backend)):
            with pytest.raises(StorageObjectNotFound):
                backend.fetch_to_file("files/00/00/absent", tmp_path / f"nope-{index}")


class TestLocalWrites:
    def test_nothing_partial_is_left_addressable(self, local_backend, tmp_path: Path) -> None:
        # Written under a temporary name and renamed, so a crash cannot leave
        # truncated bytes at the address a content hash promises.
        source = tmp_path / "source.bin"
        source.write_bytes(b"complete")
        local_backend.put_file(KEY, source)

        stored = local_backend._root  # noqa: SLF001 - asserting on the layout
        assert not list(stored.rglob("*.partial"))


class TestPrefix:
    def test_a_prefix_is_applied_to_every_key(self) -> None:
        with moto.mock_aws():
            client = boto3.client("s3", region_name="us-east-1")
            client.create_bucket(Bucket=BUCKET)
            backend = S3Backend(client, BUCKET, "dissertation/")
            backend.put_bytes(KEY, b"prefixed")

            # The prefix belongs to the bucket layout, not to the storage key:
            # the database records the key without it, so a prefix can be
            # changed without rewriting a single row.
            listed = client.list_objects_v2(Bucket=BUCKET)["Contents"]
            assert [item["Key"] for item in listed] == [f"dissertation/{KEY}"]
            assert backend.read_bytes(KEY) == b"prefixed"


class TestSelection:
    def test_local_is_the_default(self, tmp_path: Path) -> None:
        from worker.config import Config

        config = Config(
            db_host="db",
            db_port=3306,
            db_name="d",
            db_user="u",
            db_password="p",
            poll_interval_seconds=1,
            max_attempts=1,
            batch_size=1,
            stale_lock_minutes=1,
            storage_root=tmp_path,
            backup_root=tmp_path,
            geocoder_base_url="https://example.invalid",
            geocoder_user_agent=None,
            log_level="CRITICAL",
        )
        backend = create_backend(config)
        assert backend.kind == "local"
        assert str(tmp_path) in backend.describe()


class TestKeysMatchTheOtherLanguage:
    """The fixtures tests/unit/files.test.ts reads, read here too.

    Storage keys are built in both languages. Editing the fixture file changes
    both suites at once, so the two implementations cannot drift while both
    stay green -- which two hand-kept copies could not actually guarantee.
    """

    @pytest.mark.parametrize(("sha256", "expected"), _FIXTURES["originals"])
    def test_original_keys(self, sha256: str, expected: str) -> None:
        assert original_key(sha256) == expected

    @pytest.mark.parametrize(
        ("sha256", "variant", "extension", "expected"), _FIXTURES["derivatives"]
    )
    def test_derivative_keys(
        self, sha256: str, variant: str, extension: str, expected: str
    ) -> None:
        assert derivative_key(sha256, variant, extension) == expected

    @pytest.mark.parametrize("key", _FIXTURES["rejected"])
    def test_rejected_keys(self, key: str, tmp_path: Path) -> None:
        with pytest.raises(UnsafeStorageKey):
            LocalBackend(tmp_path).put_bytes(key, b"x")

    @pytest.mark.parametrize(("sha256", "variant", "extension"), _FIXTURES["rejectedDerivatives"])
    def test_rejected_derivative_arguments(
        self, sha256: str, variant: str, extension: str
    ) -> None:
        with pytest.raises(UnsafeStorageKey):
            derivative_key(sha256, variant, extension)
