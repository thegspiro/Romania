"""Bibliography import parsing.

SHARED_SLUG_FIXTURES is duplicated verbatim in tests/unit/slug.test.ts. The
worker creates sources during an import, and its slugify must agree exactly
with the TypeScript one, or the same title typed into the admin form and
imported from a file produces two different URLs. Change one list and the
other suite fails.
"""

from __future__ import annotations

import pytest

from worker.jobs.bibliography_import import (
    _issued_from_parts,
    _parse_bibtex_names,
    _parse_ris_name,
    decode_latex,
    parse_bibtex,
    parse_ris,
    slugify,
)

SHARED_SLUG_FIXTURES = [
    ("Anii Şcolii", "anii-scolii"),
    ("Bănăţeanu", "banateanu"),
    ("Iaşi", "iasi"),
    ("Între Două Lumi", "intre-doua-lumi"),
    ("Café de la Paix", "cafe-de-la-paix"),
    ("Straße", "strasse"),
    ("München", "muenchen"),
    ("Bucureşti", "bucuresti"),
    ("Ярославль", "yaroslavl"),
    ("Ærø", "aero"),
]


@pytest.mark.parametrize(("value", "expected"), SHARED_SLUG_FIXTURES)
def test_slugify_matches_typescript(value: str, expected: str) -> None:
    assert slugify(value) == expected


def test_slugify_treats_comma_below_and_cedilla_alike() -> None:
    # Both forms appear interchangeably in documents and in text extracted
    # from PDFs; they must not produce two slugs for one place.
    assert slugify("București") == slugify("Bucureşti")


def test_slugify_returns_empty_when_nothing_is_sluggable() -> None:
    assert slugify("!!!") == ""


class TestLatexDecoding:
    """BibTeX exported for a LaTeX toolchain encodes every diacritic as a
    command, so a Romanian bibliography is full of \\c{S}, \\u{a} and \\^{i}."""

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (r"\c{S}coala", "Şcoala"),
            (r"B\u{a}n\u{a}\c{t}eanu", "Bănăţeanu"),
            (r"Ia\c{s}i", "Iaşi"),
            (r"\^{I}ntre", "Între"),
            (r"Caf\'{e}", "Café"),
            (r'M\"{u}nchen', "München"),
            (r"Stra\ss e", "Straße"),
            (r"\o{}re", "øre"),
            (r"AT\&T", "AT&T"),
            # Brace-free form: \cS is as valid as \c{S}.
            (r"\cS", "Ş"),
        ],
    )
    def test_decodes_accents_and_symbols(self, value: str, expected: str) -> None:
        assert decode_latex(value).replace("{", "").replace("}", "") == expected

    def test_leaves_plain_text_untouched(self) -> None:
        assert decode_latex("Ordinary Title") == "Ordinary Title"


class TestBibtex:
    def test_parses_a_book(self) -> None:
        entries = parse_bibtex(
            r"""
            @book{ionescu1998,
              title = {Anii {\c{S}}colii},
              author = {Ionescu, Maria and Popescu, Andrei},
              publisher = {Humanitas},
              address = {Bucharest},
              year = {1998}
            }
            """
        )
        assert len(entries) == 1
        item = entries[0]
        assert item["type"] == "book"
        assert item["title"] == "Anii Şcolii"
        assert item["author"] == [
            {"family": "Ionescu", "given": "Maria"},
            {"family": "Popescu", "given": "Andrei"},
        ]
        assert item["publisher"] == "Humanitas"
        assert item["publisher-place"] == "Bucharest"
        assert item["issued"] == {"date-parts": [[1998]]}

    def test_parses_a_journal_article_and_normalises_the_page_range(self) -> None:
        entries = parse_bibtex(
            r"""
            @article{popescu2001,
              title = {Peasant Revolt},
              author = {Popescu, Andrei},
              journal = {Slavic Review},
              volume = {57},
              number = {3},
              pages = {512--534},
              year = {2001}
            }
            """
        )
        item = entries[0]
        assert item["type"] == "article-journal"
        assert item["container-title"] == "Slavic Review"
        # The LaTeX en-dash ligature must not reach CSL.
        assert item["page"] == "512-534"

    def test_maps_a_thesis_and_a_month(self) -> None:
        entries = parse_bibtex(
            r"""
            @phdthesis{x2010, title = {A Thesis}, author = {Smith, John},
                       school = {Somewhere}, year = {2010}, month = {jun}}
            """
        )
        assert entries[0]["type"] == "thesis"
        assert entries[0]["issued"] == {"date-parts": [[2010, 6]]}

    def test_unknown_entry_type_falls_back_rather_than_failing(self) -> None:
        # One odd record must not abort an import of several hundred.
        entries = parse_bibtex(r"@strangetype{x, title = {A Thing}, year = {1999}}")
        assert entries[0]["type"] == "document"

    def test_empty_input_yields_no_entries(self) -> None:
        assert parse_bibtex("") == []


class TestRis:
    def test_parses_a_journal_article(self) -> None:
        entries = parse_ris(
            "TY  - JOUR\n"
            "TI  - Peasant Revolt\n"
            "AU  - Popescu, Andrei\n"
            "JO  - Slavic Review\n"
            "VL  - 57\n"
            "SP  - 512\n"
            "EP  - 534\n"
            "PY  - 2001\n"
            "ER  - \n"
        )
        assert len(entries) == 1
        item = entries[0]
        assert item["type"] == "article-journal"
        assert item["title"] == "Peasant Revolt"
        assert item["author"] == [{"family": "Popescu", "given": "Andrei"}]
        assert item["page"] == "512-534"

    def test_maps_a_manuscript(self) -> None:
        entries = parse_ris("TY  - MANSCPT\nTI  - A Report\nPY  - 1943\nER  - \n")
        assert entries[0]["type"] == "manuscript"


class TestNameParsing:
    def test_splits_family_and_given(self) -> None:
        assert _parse_bibtex_names("Ionescu, Maria") == [
            {"family": "Ionescu", "given": "Maria"}
        ]

    def test_infers_order_for_given_family(self) -> None:
        assert _parse_bibtex_names("Maria Ionescu") == [
            {"given": "Maria", "family": "Ionescu"}
        ]

    def test_single_word_becomes_a_literal_name(self) -> None:
        assert _parse_bibtex_names("Anonymous") == [{"literal": "Anonymous"}]

    def test_ris_literal_name(self) -> None:
        assert _parse_ris_name("Ministry of the Interior") == {
            "literal": "Ministry of the Interior"
        }


class TestDates:
    def test_extracts_a_year(self) -> None:
        assert _issued_from_parts("1998", None) == {"date-parts": [[1998]]}

    def test_accepts_a_numeric_month(self) -> None:
        assert _issued_from_parts("1998", "6") == {"date-parts": [[1998, 6]]}

    def test_keeps_an_imprecise_date_verbatim(self) -> None:
        # "c. 1943" and "n.d." are meaningful in historical bibliography, so
        # they are preserved rather than discarded.
        assert _issued_from_parts("n.d.", None) == {"literal": "n.d."}

    def test_finds_a_year_inside_surrounding_text(self) -> None:
        assert _issued_from_parts("published 1998", None) == {"date-parts": [[1998]]}
