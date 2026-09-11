"""Zotero sync.

Nothing here touches the network. What is worth testing is the part that would
be silently wrong in a year's time: that a sync cannot erase the archival
apparatus the researcher typed on this side, that a citation key never moves,
that paging stops, and that a near-match is never guessed at.

The database writes are covered by tests/integration/zotero.test.ts, which runs
against a real MySQL -- the constraints are the thing being asserted there, and
a fake connection would prove none of them.
"""

from __future__ import annotations

import os
from typing import Any

import pytest
import requests

from worker.config import ConfigError, load_config
from worker.jobs import zotero_sync
from worker.jobs.zotero_sync import (
    PAGE_SIZE,
    SyncCounts,
    ZoteroLibraryChanged,
    ZoteroUnavailable,
    _accessed_date,
    _detail_values,
    _issued_year,
    _merge_local_fields,
    _normalize_isbn,
)

BASE_ENV = {
    "DB_PASSWORD": "test-password",
    "ZOTERO_LIBRARY_ID": "12345",
    "ZOTERO_API_KEY": "abcdef",
}


def _load(**overrides: str) -> Any:
    """Loads a Config with Zotero configured, leaving the environment as found."""
    previous = dict(os.environ)
    os.environ.update({**BASE_ENV, **overrides})
    try:
        return load_config()
    finally:
        os.environ.clear()
        os.environ.update(previous)


# --- Configuration ---------------------------------------------------------


def test_library_type_defaults_to_user() -> None:
    assert _load().zotero_library_type == "user"


def test_library_type_must_be_user_or_group() -> None:
    with pytest.raises(ConfigError, match="ZOTERO_LIBRARY_TYPE"):
        _load(ZOTERO_LIBRARY_TYPE="institution")


def test_library_id_must_be_numeric() -> None:
    # Caught at start-up rather than as a 404 halfway through a sync.
    with pytest.raises(ConfigError, match="ZOTERO_LIBRARY_ID"):
        _load(ZOTERO_LIBRARY_ID="my-library")


def test_sync_refuses_to_run_without_credentials() -> None:
    previous = dict(os.environ)
    os.environ.update({"DB_PASSWORD": "test-password"})
    for name in ("ZOTERO_LIBRARY_ID", "ZOTERO_API_KEY"):
        os.environ.pop(name, None)
    try:
        unconfigured = load_config()
    finally:
        os.environ.clear()
        os.environ.update(previous)

    assert unconfigured.zotero_configured is False
    with pytest.raises(ZoteroUnavailable, match="ZOTERO_LIBRARY_ID"):
        zotero_sync.run(None, unconfigured, {})  # type: ignore[arg-type]


# --- Preserving what this side owns ----------------------------------------


def test_local_archival_fields_survive_a_sync() -> None:
    """The reason the merge exists.

    Chicago renders the call number from csl_json, not from the column beside
    it. Taking Zotero's record wholesale would strip a fond and dosar reference
    out of every footnote while the column still held the value.
    """
    incoming = {"type": "manuscript", "title": "Raport", "publisher": "n.p."}
    existing = {
        "type": "manuscript",
        "title": "Raport",
        "archive": "Arhivele Naționale ale României",
        "archive_location": "București",
        "call-number": "Fond 2242, dosar 17/1941",
        "accessed": {"date-parts": [[2024, 3, 9]]},
    }

    merged = _merge_local_fields(incoming, existing)

    assert merged["call-number"] == "Fond 2242, dosar 17/1941"
    assert merged["archive"] == "Arhivele Naționale ale României"
    assert merged["archive_location"] == "București"
    assert merged["accessed"] == {"date-parts": [[2024, 3, 9]]}
    # Everything else is Zotero's to say.
    assert merged["publisher"] == "n.p."


def test_zotero_supplies_archival_fields_this_side_lacks() -> None:
    merged = _merge_local_fields(
        {"type": "book", "archive": "BAR", "call-number": "II 45.221"},
        {"type": "book"},
    )
    assert merged["archive"] == "BAR"
    assert merged["call-number"] == "II 45.221"


def test_empty_local_value_does_not_mask_zoteros() -> None:
    merged = _merge_local_fields({"archive": "BAR"}, {"archive": ""})
    assert merged["archive"] == "BAR"


def test_derived_columns_track_the_merged_json() -> None:
    """The columns are copies of the JSON; the merge must not split them."""
    merged = _merge_local_fields(
        {"type": "book", "title": "Anii", "URL": "https://example.org"},
        {"archive": "ANR", "call-number": "Fond 2242"},
    )
    values = _detail_values(merged)

    assert values[0] == "book"
    assert values[4] == "ANR"
    assert values[6] == "Fond 2242"
    assert values[7] == "https://example.org"


# --- Values ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("978-973-50-1234-5", "9789735012345"),
        ("9789735012345", "9789735012345"),
        ("0-19-820171-X", "019820171X"),
        # Several ISBNs: the first identifies the work well enough, and
        # comparing sets would match a paperback to its hardback.
        ("9789735012345 9786068494012", "9789735012345"),
        (None, ""),
        ("", ""),
    ],
)
def test_isbn_normalisation(value: str | None, expected: str) -> None:
    assert _normalize_isbn(value) == expected


def test_issued_year_reads_the_first_date_part() -> None:
    assert _issued_year({"date-parts": [[1941, 6, 22]]}) == 1941


def test_literal_date_has_no_year_column() -> None:
    # "c. 1943" survives in csl_json, which is what Chicago renders. Inventing
    # a year for the column would claim a precision the record does not carry.
    assert _issued_year({"literal": "c. 1943"}) is None


def test_accessed_date_needs_a_whole_day() -> None:
    assert _accessed_date({"date-parts": [[2024, 3, 9]]}) == "2024-03-09"
    # A DATE column is a calendar day; a year alone is not one.
    assert _accessed_date({"date-parts": [[2024]]}) is None
    assert _accessed_date({"date-parts": [[2024, 3]]}) is None
    assert _accessed_date(None) is None


def test_accessed_date_rejects_an_impossible_month() -> None:
    assert _accessed_date({"date-parts": [[2024, 13, 1]]}) is None


# --- The API walk ----------------------------------------------------------


class FakeResponse:
    def __init__(
        self,
        body: Any,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._body = body
        self.status_code = status_code
        self.headers = headers or {}

    def json(self) -> Any:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")


def entry(key: str, title: str, version: int = 1, item_type: str = "book") -> dict[str, Any]:
    return {
        "key": key,
        "version": version,
        "data": {"itemType": item_type},
        "csljson": {"id": f"http://zotero.org/users/1/items/{key}", "type": "book", "title": title},
    }


def install_pages(
    monkeypatch: pytest.MonkeyPatch,
    pages: list[FakeResponse],
) -> list[dict[str, str]]:
    """Serves `pages` in order and records the query parameters asked for."""
    seen: list[dict[str, str]] = []
    remaining = list(pages)

    def fake_get(url: str, params: dict[str, str], headers: dict[str, str], timeout: int) -> Any:
        seen.append(params)
        return remaining.pop(0)

    monkeypatch.setattr(requests, "get", fake_get)
    return seen


def test_items_are_paged_until_a_short_page(monkeypatch: pytest.MonkeyPatch) -> None:
    first = [entry(f"K{index:04d}", f"Item {index}") for index in range(PAGE_SIZE)]
    headers = {"Last-Modified-Version": "42"}
    seen = install_pages(
        monkeypatch,
        [
            FakeResponse(first, headers=headers),
            FakeResponse([entry("TAIL", "Last one")], headers=headers),
        ],
    )

    entries, version = zotero_sync._fetch_items(_load(), 0)

    assert len(entries) == PAGE_SIZE + 1
    assert version == 42
    assert [page["start"] for page in seen] == ["0", str(PAGE_SIZE)]


def test_a_library_edited_mid_walk_restarts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stitching two versions of a library together would import a state that
    never existed. Raising hands it back to the runner's retry."""
    full_page = [entry(f"K{index:04d}", f"Item {index}") for index in range(PAGE_SIZE)]
    install_pages(
        monkeypatch,
        [
            FakeResponse(full_page, headers={"Last-Modified-Version": "42"}),
            FakeResponse([], headers={"Last-Modified-Version": "43"}),
        ],
    )

    with pytest.raises(ZoteroLibraryChanged):
        zotero_sync._fetch_items(_load(), 0)


def test_since_is_passed_through(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = install_pages(
        monkeypatch, [FakeResponse([], headers={"Last-Modified-Version": "99"})]
    )
    zotero_sync._fetch_items(_load(), 42)
    assert seen[0]["since"] == "42"


def test_a_rejected_key_names_the_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    install_pages(monkeypatch, [FakeResponse({}, status_code=403)])
    with pytest.raises(ZoteroUnavailable, match="ZOTERO_API_KEY"):
        zotero_sync._fetch_items(_load(), 0)


def test_rate_limiting_is_left_to_the_runners_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    # Sleeping inside a job would hold its queue lock for the duration.
    install_pages(
        monkeypatch, [FakeResponse({}, status_code=429, headers={"Retry-After": "120"})]
    )
    with pytest.raises(ZoteroUnavailable, match="120"):
        zotero_sync._fetch_items(_load(), 0)


def test_deleted_keys_are_read_from_the_items_list(monkeypatch: pytest.MonkeyPatch) -> None:
    install_pages(
        monkeypatch,
        [FakeResponse({"items": ["AAAA1111", "BBBB2222"], "collections": ["CCCC"]})],
    )
    assert zotero_sync._fetch_deleted(_load(), 7) == ["AAAA1111", "BBBB2222"]


# --- Skipping ---------------------------------------------------------------


@pytest.mark.parametrize("item_type", ["attachment", "note", "annotation"])
def test_child_records_are_skipped(item_type: str) -> None:
    counts = SyncCounts()
    zotero_sync._apply_entry(
        None,  # type: ignore[arg-type]
        _load(),
        entry("K1", "A note", item_type=item_type),
        counts,
    )
    assert counts.skipped == 1
    assert counts.created == 0


def test_an_untitled_item_is_skipped() -> None:
    counts = SyncCounts()
    item = entry("K2", "")
    item["csljson"]["title"] = ""
    zotero_sync._apply_entry(None, _load(), item, counts)  # type: ignore[arg-type]
    assert counts.skipped == 1
