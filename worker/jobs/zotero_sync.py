"""Zotero library sync.

Zotero is the bibliography of record. This handler pulls its items in and keeps
them in step; it never pushes anything back, so nothing here can damage the
library the researcher actually works in.

Three rules shape the whole handler:

  * **Zotero owns the bibliographic record, this side owns the apparatus.**
    A sync replaces `csl_json` and the derived columns beside it, but never
    touches `visibility`, `slug`, or the archival fields the operator typed
    here -- archive, archive location, call number, accessed date and notes.
    A fond and dosar reference is the researcher's own work; Zotero has no
    opinion about it and must not be able to erase it.

  * **The slug never changes.** References are keyed to the slug, so renaming
    one would break every `[[cite:...]]` already written. A title corrected in
    Zotero updates the title and the rendered citation; the URL stays put.

  * **Deletion in Zotero is reported, not obeyed.** A deleted item's link is
    flagged for review and the source is left alone. It may already be cited,
    and `rebuildReferences` would leave a dangling citation behind.

Incremental by default: the library version reached by the last successful run
is stored, and the next run asks Zotero only for what changed since. A failure
part-way leaves that version untouched, so the retry redoes the same window --
which is safe because every write is an upsert keyed on the Zotero item key.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import pymysql
import requests

from worker.config import Config
from worker.db import fetch_all, fetch_one, transaction

# slugify and _unique_slug live with the BibTeX importer because that is where
# they were first needed. Imported rather than copied: a second definition of
# the slug rules is exactly the drift tests/fixtures/slug-cases.json exists to
# prevent, and an imported source must land on the same slug however it came in.
from worker.jobs.bibliography_import import _unique_slug, slugify

LOGGER = logging.getLogger("worker.zotero")

REQUEST_TIMEOUT_SECONDS = 30
PAGE_SIZE = 100
# A library larger than this is not a dissertation bibliography; the cap stops
# a paging bug from walking forever against a misbehaving server.
MAX_PAGES = 500
ZOTERO_API_VERSION = "3"

# Child records carry no bibliographic identity of their own. Zotero omits
# csljson for them anyway; skipping by type says why rather than relying on
# that.
SKIPPED_ITEM_TYPES = frozenset({"attachment", "note", "annotation"})

# Fields this side owns once they have a value. Present in both csl_json and
# in a column of source_detail, so they are carried forward together and the
# column stays a faithful copy of the JSON.
LOCAL_CSL_FIELDS = ("archive", "archive_location", "call-number", "accessed")


class ZoteroUnavailable(RuntimeError):
    """The API cannot be used at all, as opposed to returning nothing."""


class ZoteroLibraryChanged(RuntimeError):
    """The library was modified while it was being paged through.

    Zotero's guidance is to start again rather than stitch two versions of the
    library together. Raising lets the runner retry with its usual backoff.
    """


@dataclass
class SyncCounts:
    created: int = 0
    updated: int = 0
    linked: int = 0
    deleted: int = 0
    skipped: int = 0
    ambiguous: list[str] = field(default_factory=list)


def run(
    connection: pymysql.connections.Connection,
    config: Config,
    payload: dict[str, Any],
) -> None:
    if config.zotero_library_id is None or config.zotero_api_key is None:
        raise ZoteroUnavailable(
            "ZOTERO_LIBRARY_ID and ZOTERO_API_KEY (or ZOTERO_API_KEY_FILE) must both be "
            "set before a library can be synced."
        )

    full = bool(payload.get("full", False))
    library_type = config.zotero_library_type
    library_id = config.zotero_library_id

    state = _load_state(connection, library_type, library_id)
    since = 0 if full else int(state["last_version"]) if state else 0
    LOGGER.info(
        "syncing zotero %s library %s from version %s%s",
        library_type,
        library_id,
        since,
        " (full resync)" if full else "",
    )

    entries, library_version = _fetch_items(config, since)
    LOGGER.info("zotero returned %s item(s), library at version %s", len(entries), library_version)

    counts = SyncCounts()
    for entry in entries:
        _apply_entry(connection, config, entry, counts)

    # Deletions are asked for with the same `since`, so a run that imports
    # nothing still learns about items removed since the last sync.
    for item_key in _fetch_deleted(config, since):
        counts.deleted += _flag_deleted(connection, library_type, library_id, item_key)

    _save_state(connection, library_type, library_id, library_version, counts)

    if counts.ambiguous:
        LOGGER.warning(
            "%s item(s) matched more than one existing source and were imported as new "
            "rather than guessed at; merge by hand: %s",
            len(counts.ambiguous),
            ", ".join(counts.ambiguous),
        )
    LOGGER.info(
        "zotero sync finished: %s created, %s linked to existing, %s updated, "
        "%s flagged deleted, %s skipped",
        counts.created,
        counts.linked,
        counts.updated,
        counts.deleted,
        counts.skipped,
    )


# --- The Zotero Web API ----------------------------------------------------


def _library_prefix(config: Config) -> str:
    plural = "users" if config.zotero_library_type == "user" else "groups"
    return f"{config.zotero_base_url.rstrip('/')}/{plural}/{config.zotero_library_id}"


def _get(config: Config, path: str, params: dict[str, str]) -> requests.Response:
    response = requests.get(
        f"{_library_prefix(config)}{path}",
        params=params,
        headers={
            "Zotero-API-Version": ZOTERO_API_VERSION,
            "Zotero-API-Key": config.zotero_api_key or "",
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )

    if response.status_code in (401, 403):
        raise ZoteroUnavailable(
            "Zotero rejected the API key. Check ZOTERO_API_KEY and that it grants read "
            f"access to {config.zotero_library_type} library {config.zotero_library_id}."
        )
    if response.status_code == 404:
        raise ZoteroUnavailable(
            f"Zotero has no {config.zotero_library_type} library "
            f"{config.zotero_library_id}. Check ZOTERO_LIBRARY_ID and ZOTERO_LIBRARY_TYPE."
        )
    if response.status_code == 429 or response.status_code >= 500:
        # Both are "come back later". Let the runner's backoff own the wait
        # rather than sleeping inside a job and holding its lock.
        retry_after = response.headers.get("Retry-After", "")
        raise ZoteroUnavailable(
            f"Zotero returned {response.status_code}"
            + (f", retry after {retry_after}s" if retry_after else "")
        )
    response.raise_for_status()

    # Zotero asks clients to pause when it sends Backoff. Honoured between
    # pages of one walk, where ignoring it would keep hammering a busy server.
    backoff = response.headers.get("Backoff")
    if backoff and backoff.isdigit():
        time.sleep(min(int(backoff), 30))

    return response


def _fetch_items(config: Config, since: int) -> tuple[list[dict[str, Any]], int]:
    """Pages through every item changed since `since`.

    Returns the entries and the library version they are consistent with. That
    version is only stored once the whole sync succeeds, so an interrupted run
    asks for the same window again instead of skipping past it.
    """
    entries: list[dict[str, Any]] = []
    library_version: int | None = None
    start = 0

    for _ in range(MAX_PAGES):
        response = _get(
            config,
            "/items",
            {
                "format": "json",
                "include": "csljson,data",
                "since": str(since),
                "limit": str(PAGE_SIZE),
                "start": str(start),
            },
        )

        page_version = _header_int(response, "Last-Modified-Version")
        if library_version is None:
            library_version = page_version
        elif page_version != library_version:
            raise ZoteroLibraryChanged(
                f"library moved from version {library_version} to {page_version} while "
                "it was being read; the sync will start again"
            )

        page = response.json()
        if not isinstance(page, list):
            raise ZoteroUnavailable("Zotero returned an items page that is not a list")

        entries.extend(item for item in page if isinstance(item, dict))
        if len(page) < PAGE_SIZE:
            return entries, library_version or since
        start += PAGE_SIZE

    raise ZoteroUnavailable(
        f"stopped after {MAX_PAGES} pages ({MAX_PAGES * PAGE_SIZE} items); "
        "this looks like a paging fault rather than a real library"
    )


def _fetch_deleted(config: Config, since: int) -> list[str]:
    response = _get(config, "/deleted", {"since": str(since)})
    body = response.json()
    if not isinstance(body, dict):
        return []
    items = body.get("items")
    if not isinstance(items, list):
        return []
    return [str(key) for key in items if isinstance(key, str) and key != ""]


def _header_int(response: requests.Response, name: str) -> int:
    raw = response.headers.get(name, "")
    return int(raw) if raw.isdigit() else 0


# --- Applying one item -----------------------------------------------------


def _apply_entry(
    connection: pymysql.connections.Connection,
    config: Config,
    entry: dict[str, Any],
    counts: SyncCounts,
) -> None:
    item_key = entry.get("key")
    if not isinstance(item_key, str) or item_key == "":
        counts.skipped += 1
        return

    data = entry.get("data")
    item_type = str(data.get("itemType", "")) if isinstance(data, dict) else ""
    if item_type in SKIPPED_ITEM_TYPES:
        counts.skipped += 1
        return

    csl = entry.get("csljson")
    if not isinstance(csl, dict):
        LOGGER.debug("item %s has no CSL-JSON representation, skipping", item_key)
        counts.skipped += 1
        return

    title = str(csl.get("title") or "").strip()
    if title == "":
        LOGGER.warning("zotero item %s has no title, skipping", item_key)
        counts.skipped += 1
        return

    version = entry.get("version")
    item_version = version if isinstance(version, int) else 0

    library_type = config.zotero_library_type
    library_id = config.zotero_library_id or ""

    existing = fetch_one(
        connection,
        """
        SELECT content_item_id FROM source_zotero_link
         WHERE library_type = %s AND library_id = %s AND item_key = %s
        """,
        (library_type, library_id, item_key),
    )

    if existing is not None:
        _update_source(connection, int(existing["content_item_id"]), csl, title)
        _touch_link(connection, int(existing["content_item_id"]), item_version)
        counts.updated += 1
        return

    matched = _find_unlinked_match(connection, csl, title)
    if matched == _AMBIGUOUS:
        counts.ambiguous.append(item_key)
    elif matched is not None:
        _update_source(connection, matched, csl, title)
        _insert_link(connection, matched, library_type, library_id, item_key, item_version)
        counts.linked += 1
        return

    content_item_id = _create_source(connection, csl, title)
    _insert_link(connection, content_item_id, library_type, library_id, item_key, item_version)
    counts.created += 1


def _create_source(
    connection: pymysql.connections.Connection,
    csl: dict[str, Any],
    title: str,
) -> int:
    slug = _unique_slug(connection, slugify(title) or "source")
    # CSL's id is the citation key, and everything downstream -- the reference
    # syntax, Pandoc, the compiled bibliography -- addresses a source by slug.
    stored = {**csl, "id": slug}

    with transaction(connection) as cursor:
        cursor.execute(
            """
            INSERT INTO content_item (kind, slug, title, language, visibility, noindex)
            VALUES ('source', %s, %s, %s, 'private', 0)
            """,
            (slug, title[:500], _optional(stored.get("language"))),
        )
        content_item_id = int(cursor.lastrowid)

        cursor.execute(
            """
            INSERT INTO source_detail
              (content_item_id, csl_type, csl_json, container_title, issued_year,
               archive, archive_location, call_number, url, accessed_on)
            VALUES (%s, %s, CAST(%s AS JSON), %s, %s, %s, %s, %s, %s, %s)
            """,
            (content_item_id, *_detail_values(stored)),
        )
    return content_item_id


def _update_source(
    connection: pymysql.connections.Connection,
    content_item_id: int,
    csl: dict[str, Any],
    title: str,
) -> None:
    current = fetch_one(
        connection,
        """
        SELECT ci.slug, sd.csl_json
          FROM content_item ci
          JOIN source_detail sd ON sd.content_item_id = ci.id
         WHERE ci.id = %s AND ci.kind = 'source'
        """,
        (content_item_id,),
    )
    if current is None:
        # The source was deleted here between the link lookup and now.
        LOGGER.info("source %s no longer exists, skipping update", content_item_id)
        return

    stored = _merge_local_fields(csl, _decode_json(current["csl_json"]))
    # The slug is the citation key and the URL. It is set once, at creation.
    stored["id"] = str(current["slug"])

    with transaction(connection) as cursor:
        cursor.execute(
            """
            UPDATE content_item
               SET title = %s, language = %s
             WHERE id = %s AND kind = 'source'
            """,
            (title[:500], _optional(stored.get("language")), content_item_id),
        )
        # visibility, slug, summary and notes are absent by design: what is
        # published, what it is called and what the researcher wrote about it
        # are decisions this side owns.
        cursor.execute(
            """
            UPDATE source_detail
               SET csl_type = %s,
                   csl_json = CAST(%s AS JSON),
                   container_title = %s,
                   issued_year = %s,
                   archive = %s,
                   archive_location = %s,
                   call_number = %s,
                   url = %s,
                   accessed_on = %s
             WHERE content_item_id = %s
            """,
            (*_detail_values(stored), content_item_id),
        )


def _merge_local_fields(
    incoming: dict[str, Any],
    existing: dict[str, Any],
) -> dict[str, Any]:
    """Carries the operator's archival apparatus across a sync.

    `archive`, `archive_location`, `call-number` and `accessed` live in
    `csl_json` as well as in their own columns, and Chicago renders them. Left
    to itself, replacing the JSON with Zotero's copy would strip a call number
    from every footnote while the column beside it still held the value.

    A field already recorded here wins; one Zotero supplies and this side does
    not have is taken. Merging in the JSON rather than patching the columns
    afterwards is what keeps the two in step.
    """
    merged = dict(incoming)
    for csl_field in LOCAL_CSL_FIELDS:
        local = existing.get(csl_field)
        if local not in (None, "", {}, []):
            merged[csl_field] = local
    return merged


def _detail_values(stored: dict[str, Any]) -> tuple[Any, ...]:
    """The source_detail columns derived from one CSL item, in column order."""
    return (
        str(stored.get("type") or "document"),
        _dump_json(stored),
        _optional(stored.get("container-title")),
        _issued_year(stored.get("issued")),
        _optional(stored.get("archive")),
        _optional(stored.get("archive_location")),
        _optional(stored.get("call-number")),
        _optional(stored.get("URL"), limit=1000),
        _accessed_date(stored.get("accessed")),
    )


# --- Matching an unlinked source -------------------------------------------

# Sentinel for "more than one candidate". Distinct from None, which means no
# candidate at all: one imports as new quietly, the other says so first.
_AMBIGUOUS = -1

_UNLINKED_FROM = """
  FROM content_item ci
  JOIN source_detail sd ON sd.content_item_id = ci.id
  LEFT JOIN source_zotero_link zl ON zl.content_item_id = ci.id
 WHERE ci.kind = 'source' AND zl.content_item_id IS NULL
"""


def _find_unlinked_match(
    connection: pymysql.connections.Connection,
    csl: dict[str, Any],
    title: str,
) -> int | None:
    """Finds a source that is plainly the same work, so a first sync adopts an
    existing bibliography instead of duplicating it.

    Identifiers first, because they are unambiguous; then an exact title and
    year, because most archival material and older books carry neither a DOI
    nor an ISBN. Anything less certain than that is left alone -- a wrong link
    silently overwrites a record on every future sync, which is far worse than
    a duplicate the operator can see and merge.
    """
    doi = str(csl.get("DOI") or "").strip().lower()
    if doi:
        rows = fetch_all(
            connection,
            f"""
            SELECT ci.id {_UNLINKED_FROM}
              AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(sd.csl_json, '$.DOI'))) = %s
            LIMIT 2
            """,
            (doi,),
        )
        if rows:
            return int(rows[0]["id"]) if len(rows) == 1 else _AMBIGUOUS

    isbn = _normalize_isbn(csl.get("ISBN"))
    if isbn:
        candidates = fetch_all(
            connection,
            f"""
            SELECT ci.id, JSON_UNQUOTE(JSON_EXTRACT(sd.csl_json, '$.ISBN')) AS isbn
            {_UNLINKED_FROM}
              AND JSON_EXTRACT(sd.csl_json, '$.ISBN') IS NOT NULL
            """,
        )
        matches = [
            int(row["id"]) for row in candidates if _normalize_isbn(row["isbn"]) == isbn
        ]
        if matches:
            return matches[0] if len(matches) == 1 else _AMBIGUOUS

    # Title and year. slugify is reused as the comparison key: it already
    # folds case, diacritics and punctuation, so "Bucureşti" and "Bucuresti"
    # compare equal without a second normalisation to keep in step.
    key = slugify(title)
    if key:
        year = _issued_year(csl.get("issued"))
        candidates = fetch_all(
            connection,
            f"""
            SELECT ci.id, ci.title {_UNLINKED_FROM}
              AND sd.issued_year <=> %s
            """,
            (year,),
        )
        matches = [
            int(row["id"]) for row in candidates if slugify(str(row["title"] or "")) == key
        ]
        if matches:
            return matches[0] if len(matches) == 1 else _AMBIGUOUS

    return None


# --- Link and state bookkeeping --------------------------------------------


def _insert_link(
    connection: pymysql.connections.Connection,
    content_item_id: int,
    library_type: str,
    library_id: str,
    item_key: str,
    item_version: int,
) -> None:
    with transaction(connection) as cursor:
        cursor.execute(
            """
            INSERT INTO source_zotero_link
              (content_item_id, library_type, library_id, item_key, item_version)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              item_version = VALUES(item_version),
              deleted_in_zotero_at = NULL
            """,
            (content_item_id, library_type, library_id, item_key, item_version),
        )


def _touch_link(
    connection: pymysql.connections.Connection,
    content_item_id: int,
    item_version: int,
) -> None:
    with transaction(connection) as cursor:
        cursor.execute(
            """
            UPDATE source_zotero_link
               SET item_version = %s, deleted_in_zotero_at = NULL
             WHERE content_item_id = %s
            """,
            (item_version, content_item_id),
        )


def _flag_deleted(
    connection: pymysql.connections.Connection,
    library_type: str,
    library_id: str,
    item_key: str,
) -> int:
    """Marks a link whose Zotero item is gone. The source itself is untouched."""
    with transaction(connection) as cursor:
        cursor.execute(
            """
            UPDATE source_zotero_link
               SET deleted_in_zotero_at = NOW(3)
             WHERE library_type = %s AND library_id = %s AND item_key = %s
               AND deleted_in_zotero_at IS NULL
            """,
            (library_type, library_id, item_key),
        )
        return int(cursor.rowcount)


def _load_state(
    connection: pymysql.connections.Connection,
    library_type: str,
    library_id: str,
) -> dict[str, Any] | None:
    return fetch_one(
        connection,
        """
        SELECT last_version, last_synced_at FROM zotero_library_state
         WHERE library_type = %s AND library_id = %s
        """,
        (library_type, library_id),
    )


def _save_state(
    connection: pymysql.connections.Connection,
    library_type: str,
    library_id: str,
    library_version: int,
    counts: SyncCounts,
) -> None:
    with transaction(connection) as cursor:
        cursor.execute(
            """
            INSERT INTO zotero_library_state
              (library_type, library_id, last_version, last_synced_at,
               created_count, updated_count, linked_count, deleted_count)
            VALUES (%s, %s, %s, NOW(3), %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              last_version = VALUES(last_version),
              last_synced_at = VALUES(last_synced_at),
              created_count = VALUES(created_count),
              updated_count = VALUES(updated_count),
              linked_count = VALUES(linked_count),
              deleted_count = VALUES(deleted_count)
            """,
            (
                library_type,
                library_id,
                library_version,
                counts.created,
                counts.updated,
                counts.linked,
                counts.deleted,
            ),
        )


# --- Value helpers ---------------------------------------------------------


def _optional(value: Any, limit: int | None = None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    return text[:limit] if limit is not None else text


def _normalize_isbn(value: Any) -> str:
    """Strips the punctuation ISBNs are printed with.

    Zotero stores whatever the catalogue gave it, so the same book arrives as
    "978-973-50-1234-5" from one library and "9789735012345" from another.
    A record with several ISBNs keeps only the first: it is enough to identify
    the work, and comparing sets would match a paperback to its hardback.
    """
    if value is None:
        return ""
    first = str(value).replace(",", " ").split()
    if not first:
        return ""
    return "".join(character for character in first[0] if character.isalnum()).upper()


def _issued_year(issued: Any) -> int | None:
    if not isinstance(issued, dict):
        return None
    parts = issued.get("date-parts")
    if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
        first = parts[0][0]
        if isinstance(first, int):
            return first
        if isinstance(first, str) and first.isdigit():
            return int(first)
    # A literal date such as "n.d." or "c. 1943" has no year column value;
    # the string survives in csl_json and is what Chicago renders.
    return None


def _accessed_date(accessed: Any) -> str | None:
    """A full year-month-day from CSL, as a DATE literal.

    A DATE column is a calendar day. An access date with only a year recorded
    is not one, so it stays in the JSON and the column is left empty rather
    than inventing 1 January.
    """
    if not isinstance(accessed, dict):
        return None
    parts = accessed.get("date-parts")
    if not (isinstance(parts, list) and parts and isinstance(parts[0], list)):
        return None
    values = [int(part) for part in parts[0] if isinstance(part, int)]
    if len(values) < 3:
        return None
    year, month, day = values[0], values[1], values[2]
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def _dump_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _decode_json(raw: Any) -> dict[str, Any]:
    decoded = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    return decoded if isinstance(decoded, dict) else {}
