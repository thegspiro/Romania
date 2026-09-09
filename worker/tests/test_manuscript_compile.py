"""Rendering an assembled manuscript with Pandoc.

The handler is deliberately thin -- it makes no visibility decisions and does
no reference parsing -- so what is worth testing is the part that would be
silently wrong: that Pandoc is invoked with the arguments Chicago citations
need, that its output lands content-addressed at the right key, and that a
failure is recorded on the build rather than swallowed.

The end-to-end case runs the real Pandoc. It is skipped when Pandoc is not
installed, so check the output before believing a green run covered it.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from worker.config import Config
from worker.jobs import manuscript_compile
from worker.jobs.manuscript_compile import FORMATS, CompileError

PANDOC = shutil.which("pandoc")
requires_pandoc = pytest.mark.skipif(PANDOC is None, reason="pandoc is not installed")

DOCUMENT = """---
title: "A Dissertation on Romania"
author: "Test Operator"
link-citations: true
---

# Opening Chapter {#sec-essay-opening-chapter}

The commission met in July.[@the-hooligan-year, 45-47]

## Conclusion {#sec-essay-conclusion}

See [Opening Chapter](#sec-essay-opening-chapter).
"""

BIBLIOGRAPHY: list[dict[str, Any]] = [
    {
        "id": "the-hooligan-year",
        "type": "book",
        "title": "The Hooligan Year",
        "author": [{"family": "Ionescu", "given": "Maria"}],
        "publisher": "Humanitas",
        "publisher-place": "Bucharest",
        "issued": {"date-parts": [[1998]]},
    }
]


def make_config(storage_root: Path) -> Config:
    return Config(
        db_host="127.0.0.1",
        db_port=3306,
        db_name="dissertation_test",
        db_user="dissertation",
        db_password="testpass",
        poll_interval_seconds=1,
        max_attempts=3,
        batch_size=1,
        stale_lock_minutes=10,
        storage_root=storage_root,
        backup_root=storage_root / "backups",
        geocoder_base_url="https://example.invalid",
        geocoder_user_agent=None,
        log_level="CRITICAL",
    )


def stage(storage_root: Path, build_id: int, *, bibliography: bool = True) -> None:
    staging = storage_root / "builds" / str(build_id)
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "document.md").write_text(DOCUMENT, encoding="utf-8")
    if bibliography:
        (staging / "references.json").write_text(
            json.dumps(BIBLIOGRAPHY, indent=2), encoding="utf-8"
        )


class TestFormats:
    def test_every_format_names_a_writer_extension_and_mime_type(self) -> None:
        assert set(FORMATS) == {"pdf", "docx", "html", "latex", "markdown"}
        for writer, extension, mime_type in FORMATS.values():
            assert writer
            assert extension.isalnum()
            assert "/" in mime_type


class TestStyle:
    def test_a_missing_style_is_an_error_rather_than_silently_unstyled(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # Rendering without the Chicago style would produce a document whose
        # citations are wrong in a way nobody notices until submission.
        monkeypatch.setattr(manuscript_compile, "CSL_STYLE", tmp_path / "absent.csl")
        monkeypatch.setattr(manuscript_compile, "CSL_STYLE_FALLBACK", tmp_path / "absent2.csl")
        with pytest.raises(CompileError):
            manuscript_compile._style_path()

    def test_the_vendored_style_is_present_in_the_source_tree(self) -> None:
        assert manuscript_compile._style_path().is_file()


class TestCompile:
    def test_a_missing_document_is_reported_not_ignored(self, tmp_path: Path) -> None:
        config = make_config(tmp_path)
        with pytest.raises(CompileError, match="assembled document missing"):
            manuscript_compile._compile(config, 1, "html")

    def test_pandoc_is_invoked_without_a_shell_and_with_citeproc(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 7)
        recorded: dict[str, Any] = {}

        class Completed:
            returncode = 0
            stderr = b""

        def fake_run(command: list[str], **kwargs: Any) -> Completed:
            recorded["command"] = command
            recorded["kwargs"] = kwargs
            # Pandoc's job is to write the output file; stand in for it.
            output = next(
                arg.split("=", 1)[1] for arg in command if arg.startswith("--output=")
            )
            Path(output).write_bytes(b"<h1>Opening Chapter</h1>")
            return Completed()

        monkeypatch.setattr(manuscript_compile.subprocess, "run", fake_run)
        stored = manuscript_compile._compile(config, 7, "html")

        command = recorded["command"]
        assert command[0] == "pandoc"
        assert "--citeproc" in command
        assert any(arg.startswith("--csl=") for arg in command)
        assert any(arg.startswith("--bibliography=") for arg in command)
        assert "--from=markdown+header_attributes+fenced_code_attributes" in command
        assert "--to=html5" in command
        # A fixed argv straight to execve: nothing in a title or path can be
        # read as a shell metacharacter.
        assert recorded["kwargs"].get("shell") in (None, False)
        assert recorded["kwargs"].get("timeout") == manuscript_compile.PANDOC_TIMEOUT_SECONDS

        # Stored content-addressed, at the same layout the TypeScript side uses.
        assert stored["storage_key"] == (
            f"files/{stored['sha256'][0:2]}/{stored['sha256'][2:4]}/{stored['sha256']}"
        )
        written = (tmp_path / stored["storage_key"]).read_bytes()
        assert written == b"<h1>Opening Chapter</h1>"
        assert stored["byte_size"] == len(written)
        # Nothing partial is left beside it.
        assert list((tmp_path / stored["storage_key"]).parent.glob("*.partial")) == []

    def test_a_pdf_build_selects_the_tectonic_engine(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 8)
        recorded: dict[str, Any] = {}

        class Completed:
            returncode = 0
            stderr = b""

        def fake_run(command: list[str], **kwargs: Any) -> Completed:
            recorded["command"] = command
            output = next(
                arg.split("=", 1)[1] for arg in command if arg.startswith("--output=")
            )
            Path(output).write_bytes(b"%PDF-1.7\n")
            return Completed()

        monkeypatch.setattr(manuscript_compile.subprocess, "run", fake_run)
        manuscript_compile._compile(config, 8, "pdf")
        assert "--pdf-engine=tectonic" in recorded["command"]

    def test_an_empty_bibliography_is_not_passed_to_pandoc(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # `--bibliography` pointing at `[]` makes Pandoc warn on every run.
        config = make_config(tmp_path)
        stage(tmp_path, 9, bibliography=False)
        (tmp_path / "builds" / "9" / "references.json").write_text("[]", encoding="utf-8")
        recorded: dict[str, Any] = {}

        class Completed:
            returncode = 0
            stderr = b""

        def fake_run(command: list[str], **kwargs: Any) -> Completed:
            recorded["command"] = command
            output = next(
                arg.split("=", 1)[1] for arg in command if arg.startswith("--output=")
            )
            Path(output).write_bytes(b"x")
            return Completed()

        monkeypatch.setattr(manuscript_compile.subprocess, "run", fake_run)
        manuscript_compile._compile(config, 9, "html")
        assert not any(arg.startswith("--bibliography=") for arg in recorded["command"])

    def test_a_nonzero_exit_carries_pandoc_stderr_into_the_error(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 10)

        class Completed:
            returncode = 43
            stderr = b"YAML parse exception on line 3"

        monkeypatch.setattr(
            manuscript_compile.subprocess, "run", lambda *a, **k: Completed()
        )
        with pytest.raises(CompileError, match="YAML parse exception"):
            manuscript_compile._compile(config, 10, "html")

    def test_success_without_an_output_file_is_still_a_failure(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 11)

        class Completed:
            returncode = 0
            stderr = b""

        monkeypatch.setattr(
            manuscript_compile.subprocess, "run", lambda *a, **k: Completed()
        )
        with pytest.raises(CompileError, match="produced no file"):
            manuscript_compile._compile(config, 11, "html")

    def test_the_staging_path_is_taken_from_the_configured_root(self, tmp_path: Path) -> None:
        # `resolve` anchors the build directory under the configured root, so
        # pointing the worker elsewhere finds nothing rather than reading the
        # previous root's files.
        stage(tmp_path, 12)
        elsewhere = replace(make_config(tmp_path), storage_root=tmp_path / "nested")
        with pytest.raises(CompileError, match="assembled document missing"):
            manuscript_compile._compile(elsewhere, 12, "html")


class TestRunValidation:
    @pytest.mark.parametrize("build_id", ["7", 7.0, None, True, False, 0, -1, {"id": 7}])
    def test_a_build_id_that_is_not_an_integer_is_refused(
        self, build_id: Any, tmp_path: Path
    ) -> None:
        # build_id reaches a storage path through an f-string, so it must be an
        # integer before anything else happens. `True` is caught too: bool is a
        # subclass of int, and "builds/True" is not a directory anyone meant.
        with pytest.raises(ValueError, match="buildId"):
            manuscript_compile.run(None, make_config(tmp_path), {"buildId": build_id})

    def test_a_missing_build_id_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="buildId"):
            manuscript_compile.run(None, make_config(tmp_path), {})


@requires_pandoc
class TestEndToEnd:
    def test_html_carries_chicago_footnotes_and_a_bibliography(self, tmp_path: Path) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 20)

        stored = manuscript_compile._compile(config, 20, "html")
        html = (tmp_path / stored["storage_key"]).read_text(encoding="utf-8")

        assert stored["mime_type"] == "text/html"
        # Both sections, with the assembler's anchors preserved as real ids.
        assert 'id="sec-essay-opening-chapter"' in html
        assert 'id="sec-essay-conclusion"' in html
        assert "#sec-essay-opening-chapter" in html

        # Chicago notes-bibliography: a numbered footnote and a reference list
        # entry, rendered by citeproc rather than written by hand.
        assert "footnote-ref" in html
        assert "The Hooligan Year" in html
        assert "45" in html
        assert "Humanitas" in html
        # The citation key itself must not survive into the rendered document.
        assert "@the-hooligan-year" not in html

    def test_the_same_document_compiles_to_docx(self, tmp_path: Path) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 21)

        stored = manuscript_compile._compile(config, 21, "docx")
        contents = (tmp_path / stored["storage_key"]).read_bytes()

        assert stored["mime_type"].endswith("wordprocessingml.document")
        # A DOCX is a zip; the magic bytes are the cheapest real assertion.
        assert contents[:2] == b"PK"
        assert stored["byte_size"] > 0

    def test_identical_output_is_stored_once(self, tmp_path: Path) -> None:
        config = make_config(tmp_path)
        stage(tmp_path, 30)
        stage(tmp_path, 31)

        first = manuscript_compile._compile(config, 30, "html")
        second = manuscript_compile._compile(config, 31, "html")

        assert first["sha256"] == second["sha256"]
        assert first["storage_key"] == second["storage_key"]
