"""BibTeX and RIS import.

Retyping citations that already exist in Zotero is the single most tedious
part of building a bibliography, and retyping is where errors enter. This
handler converts an exported file into the same CSL-JSON shape the web service
writes, so imported and hand-entered sources are indistinguishable afterwards.

Imported sources are created **private**. An import can pull in hundreds of
records at once, and publishing them by default would put unreviewed material
on a public site.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any

import pymysql

from worker.config import Config
from worker.db import fetch_one, transaction

LOGGER = logging.getLogger("worker.bibliography")

# BibTeX entry types mapped to CSL item types. Anything unlisted becomes
# 'document', which renders sensibly rather than failing the whole import.
BIBTEX_TO_CSL: dict[str, str] = {
    "article": "article-journal",
    "book": "book",
    "booklet": "book",
    "inbook": "chapter",
    "incollection": "chapter",
    "inproceedings": "paper-conference",
    "conference": "paper-conference",
    "manual": "report",
    "mastersthesis": "thesis",
    "phdthesis": "thesis",
    "misc": "document",
    "proceedings": "book",
    "techreport": "report",
    "unpublished": "manuscript",
}

# RIS reference types.
RIS_TO_CSL: dict[str, str] = {
    "BOOK": "book",
    "CHAP": "chapter",
    "JOUR": "article-journal",
    "MGZN": "article-magazine",
    "NEWS": "article-newspaper",
    "THES": "thesis",
    "RPRT": "report",
    "CONF": "paper-conference",
    "CPAPER": "paper-conference",
    "MANSCPT": "manuscript",
    "UNPB": "manuscript",
    "ELEC": "webpage",
    "GEN": "document",
}

MAX_SLUG_LENGTH = 190

# Must stay byte-for-byte equivalent to TRANSLITERATIONS in src/content/slug.ts.
# tests/unit/slug.test.ts and worker/tests/test_bibliography_import.py check the
# same fixture list against both implementations, so a change to one that is not
# mirrored in the other fails the suite rather than silently diverging.
TRANSLITERATION = str.maketrans(
    {
        "ș": "s", "ş": "s", "ț": "t", "ţ": "t",
        "ß": "ss", "ä": "ae", "ö": "oe", "ü": "ue",
        "æ": "ae", "ø": "o", "å": "a", "đ": "d", "ð": "d", "þ": "th", "ł": "l",
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh",
        "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n",
        "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
        "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "",
        "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    }
)


def slugify(value: str) -> str:
    """Mirrors `slugify` in src/content/slug.ts.

    Kept deliberately in step with the TypeScript implementation: an imported
    source and a hand-entered one with the same title must produce the same
    slug, or the uniqueness suffixes drift apart between the two paths.
    """
    lowered = value.lower().translate(TRANSLITERATION)
    decomposed = unicodedata.normalize("NFD", lowered)
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    slug = re.sub(r"[^a-z0-9]+", "-", stripped).strip("-")
    return slug[:MAX_SLUG_LENGTH].rstrip("-")


def parse_bibtex(text: str) -> list[dict[str, Any]]:
    import bibtexparser
    from bibtexparser.bparser import BibTexParser

    parser = BibTexParser(common_strings=True)
    parser.ignore_nonstandard_types = False
    database = bibtexparser.loads(text, parser=parser)

    items: list[dict[str, Any]] = []
    for entry in database.entries:
        entry_type = str(entry.get("ENTRYTYPE", "misc")).lower()
        item: dict[str, Any] = {"type": BIBTEX_TO_CSL.get(entry_type, "document")}

        if "title" in entry:
            item["title"] = _clean_braces(entry["title"])
        if "author" in entry:
            item["author"] = _parse_bibtex_names(entry["author"])
        if "editor" in entry:
            item["editor"] = _parse_bibtex_names(entry["editor"])
        if "journal" in entry:
            item["container-title"] = _clean_braces(entry["journal"])
        elif "booktitle" in entry:
            item["container-title"] = _clean_braces(entry["booktitle"])

        for bib_field, csl_field in (
            ("publisher", "publisher"),
            ("address", "publisher-place"),
            ("volume", "volume"),
            ("number", "issue"),
            ("pages", "page"),
            ("edition", "edition"),
            ("doi", "DOI"),
            ("isbn", "ISBN"),
            ("url", "URL"),
            ("note", "note"),
            ("language", "language"),
        ):
            if bib_field in entry:
                item[csl_field] = _clean_braces(entry[bib_field])

        if "page" in item:
            # BibTeX writes page ranges with an en-dash ligature.
            item["page"] = item["page"].replace("--", "-")

        year = entry.get("year")
        if year:
            issued = _issued_from_parts(year, entry.get("month"))
            if issued is not None:
                item["issued"] = issued

        items.append(item)

    return items


def parse_ris(text: str) -> list[dict[str, Any]]:
    import rispy

    items: list[dict[str, Any]] = []
    for entry in rispy.loads(text):
        reference_type = str(entry.get("type_of_reference", "GEN")).upper()
        item: dict[str, Any] = {"type": RIS_TO_CSL.get(reference_type, "document")}

        title = entry.get("title") or entry.get("primary_title")
        if title:
            item["title"] = str(title)

        authors = entry.get("authors") or entry.get("first_authors") or []
        if authors:
            item["author"] = [_parse_ris_name(str(name)) for name in authors]

        container = entry.get("journal_name") or entry.get("secondary_title")
        if container:
            item["container-title"] = str(container)

        for ris_field, csl_field in (
            ("publisher", "publisher"),
            ("place_published", "publisher-place"),
            ("volume", "volume"),
            ("number", "issue"),
            ("doi", "DOI"),
            ("url", "URL"),
            ("language", "language"),
            ("notes_abstract", "note"),
        ):
            value = entry.get(ris_field)
            if value:
                item[csl_field] = str(value)

        start = entry.get("start_page")
        end = entry.get("end_page")
        if start and end:
            item["page"] = f"{start}-{end}"
        elif start:
            item["page"] = str(start)

        year = entry.get("year") or entry.get("publication_year")
        if year:
            issued = _issued_from_parts(str(year), None)
            if issued is not None:
                item["issued"] = issued

        items.append(item)

    return items


def run(
    connection: pymysql.connections.Connection,
    config: Config,
    payload: dict[str, Any],
) -> None:
    text = payload.get("content")
    fmt = str(payload.get("format", "")).lower()

    if not isinstance(text, str) or text.strip() == "":
        raise ValueError("payload.content must be a non-empty string")
    if fmt not in ("bibtex", "ris"):
        raise ValueError("payload.format must be 'bibtex' or 'ris'")

    items = parse_bibtex(text) if fmt == "bibtex" else parse_ris(text)
    LOGGER.info("parsed %s record(s) from %s import", len(items), fmt)

    imported = 0
    for item in items:
        title = str(item.get("title") or "").strip()
        if title == "":
            LOGGER.warning("skipping a record with no title")
            continue
        if _insert_source(connection, config, item, title):
            imported += 1

    LOGGER.info("imported %s of %s record(s)", imported, len(items))


def _insert_source(
    connection: pymysql.connections.Connection,
    _config: Config,
    item: dict[str, Any],
    title: str,
) -> bool:
    slug = _unique_slug(connection, slugify(title) or "source")
    item = {**item, "id": slug}

    with transaction(connection) as cursor:
        cursor.execute(
            """
            INSERT INTO content_item
              (kind, slug, title, language, visibility, noindex)
            VALUES ('source', %s, %s, %s, 'private', 0)
            """,
            (slug, title[:500], (item.get("language") or None)),
        )
        content_item_id = cursor.lastrowid

        issued_year = None
        date_parts = item.get("issued", {}).get("date-parts")
        if isinstance(date_parts, list) and date_parts and isinstance(date_parts[0], list):
            first = date_parts[0]
            if first and isinstance(first[0], int):
                issued_year = first[0]

        cursor.execute(
            """
            INSERT INTO source_detail
              (content_item_id, csl_type, csl_json, container_title, issued_year, url)
            VALUES (%s, %s, CAST(%s AS JSON), %s, %s, %s)
            """,
            (
                content_item_id,
                item["type"],
                json.dumps(item, ensure_ascii=False),
                (item.get("container-title") or None),
                issued_year,
                (item.get("URL") or None),
            ),
        )
    return True


def _unique_slug(connection: pymysql.connections.Connection, base: str) -> str:
    candidate = base
    for suffix in range(1, 1000):
        existing = fetch_one(
            connection,
            "SELECT id FROM content_item WHERE kind = 'source' AND slug = %s",
            (candidate,),
        )
        if existing is None:
            return candidate
        tail = f"-{suffix + 1}"
        candidate = f"{base[: MAX_SLUG_LENGTH - len(tail)].rstrip('-')}{tail}"
    raise RuntimeError(f"could not find a free slug based on {base!r}")


# --- Helpers ---------------------------------------------------------------

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _issued_from_parts(year: str, month: str | None) -> dict[str, Any] | None:
    match = re.search(r"\d{3,4}", str(year))
    if match is None:
        # Keep unparseable dates rather than dropping them: "n.d." and
        # "c. 1943" are meaningful in historical bibliography.
        return {"literal": str(year).strip()} if str(year).strip() else None

    parts: list[int] = [int(match.group())]
    if month:
        key = str(month).strip().lower()[:3]
        if key in MONTHS:
            parts.append(MONTHS[key])
        elif key.isdigit() and 1 <= int(key) <= 12:
            parts.append(int(key))
    return {"date-parts": [parts]}


# LaTeX accent commands mapped to the Unicode combining mark they apply.
# BibTeX files written for a LaTeX toolchain encode every diacritic this way,
# so a Romanian bibliography exported from Zotero is full of \c{S}, \u{a} and
# \^{i}. Without this the titles import as "Anii \cScolii" instead of
# "Anii Școlii", and the slug and the search index inherit the damage.
LATEX_ACCENTS: dict[str, str] = {
    "`": "\u0300",  # grave
    "'": "\u0301",  # acute
    "^": "\u0302",  # circumflex
    "~": "\u0303",  # tilde
    "=": "\u0304",  # macron
    "u": "\u0306",  # breve            -- Romanian ă
    ".": "\u0307",  # dot above
    '"': "\u0308",  # diaeresis
    "r": "\u030a",  # ring above
    "H": "\u030b",  # double acute
    "v": "\u030c",  # caron
    "d": "\u0323",  # dot below
    "c": "\u0327",  # cedilla          -- Romanian ș, ț
    "k": "\u0328",  # ogonek
    "b": "\u0331",  # macron below
}

# Commands that stand for a whole character rather than an accent.
LATEX_LITERALS: dict[str, str] = {
    "ss": "ß",
    "ae": "æ",
    "AE": "Æ",
    "oe": "œ",
    "OE": "Œ",
    "aa": "å",
    "AA": "Å",
    "o": "ø",
    "O": "Ø",
    "l": "ł",
    "L": "Ł",
    "i": "ı",
    "&": "&",
    "%": "%",
    "$": "$",
    "#": "#",
    "_": "_",
}

_ACCENT_PATTERN = re.compile(
    r"\\([`'^~=\"u.rHvdckb])\s*(?:\{\s*(\w)\s*\}|(\w))",
)
# A control word swallows the whitespace that terminates it, which is how
# LaTeX itself reads "Stra\ss e" as "Straße" rather than "Straß e".
_LITERAL_PATTERN = re.compile(r"\\(ss|ae|AE|oe|OE|aa|AA|[oOlLi])(?![A-Za-z])\s?|\\([&%$#_])")


def decode_latex(value: str) -> str:
    """Converts LaTeX accent and symbol commands into their Unicode characters."""

    def accent(match: re.Match[str]) -> str:
        mark = LATEX_ACCENTS[match.group(1)]
        letter = match.group(2) or match.group(3) or ""
        # Composing then normalising yields the precomposed character where
        # one exists, and leaves the combining pair where it does not.
        return unicodedata.normalize("NFC", letter + mark)

    def literal(match: re.Match[str]) -> str:
        command = match.group(1) or match.group(2) or ""
        return LATEX_LITERALS.get(command, command)

    decoded = _ACCENT_PATTERN.sub(accent, value)
    return _LITERAL_PATTERN.sub(literal, decoded)


def _clean_braces(value: str) -> str:
    """Decodes LaTeX escapes, removes protective braces and collapses whitespace."""
    decoded = decode_latex(value)
    return re.sub(r"\s+", " ", decoded.replace("{", "").replace("}", "")).strip()


def _parse_bibtex_names(value: str) -> list[dict[str, str]]:
    names: list[dict[str, str]] = []
    for raw in re.split(r"\s+and\s+", _clean_braces(value)):
        name = raw.strip()
        if name == "":
            continue
        if "," in name:
            family, _, given = name.partition(",")
            names.append({"family": family.strip(), "given": given.strip()})
        else:
            # "Given Family" order. Splitting on the last space is a guess,
            # but BibTeX offers nothing better and a literal name would sort
            # every such entry under its first name.
            parts = name.rsplit(" ", 1)
            if len(parts) == 2:
                names.append({"given": parts[0].strip(), "family": parts[1].strip()})
            else:
                names.append({"literal": name})
    return names


def _parse_ris_name(name: str) -> dict[str, str]:
    if "," in name:
        family, _, given = name.partition(",")
        return {"family": family.strip(), "given": given.strip()}
    return {"literal": name.strip()}
