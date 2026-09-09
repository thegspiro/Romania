"""Worker configuration loading."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from worker.config import ConfigError, load_config

BASE_ENV = {
    "DB_HOST": "db",
    "DB_PORT": "3306",
    "DB_NAME": "dissertation",
    "DB_USER": "dissertation",
    "DB_PASSWORD": "secret",
}


@pytest.fixture(autouse=True)
def clean_environment() -> Iterator[None]:
    """Isolates each test from the ambient environment."""
    saved = dict(os.environ)
    for name in list(os.environ):
        if name.startswith(("DB_", "WORKER_", "STORAGE_", "BACKUP_", "GEOCODER_", "LOG_")):
            del os.environ[name]
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


def set_env(**values: str) -> None:
    os.environ.update(BASE_ENV)
    os.environ.update(values)


def test_loads_a_valid_configuration() -> None:
    set_env()
    config = load_config()
    assert config.db_name == "dissertation"
    assert config.db_port == 3306
    assert config.poll_interval_seconds == 5
    assert config.storage_root == Path("/data/files")


def test_requires_a_password() -> None:
    os.environ.update({key: value for key, value in BASE_ENV.items() if key != "DB_PASSWORD"})
    with pytest.raises(ConfigError, match="DB_PASSWORD"):
        load_config()


def test_reads_a_password_from_a_file(tmp_path: Path) -> None:
    # The _FILE form keeps the credential out of the process environment,
    # where `docker inspect` would show it.
    secret = tmp_path / "db_password"
    secret.write_text("from-a-file\n", encoding="utf-8")

    os.environ.update({key: value for key, value in BASE_ENV.items() if key != "DB_PASSWORD"})
    os.environ["DB_PASSWORD_FILE"] = str(secret)
    assert load_config().db_password == "from-a-file"


def test_refuses_both_password_forms(tmp_path: Path) -> None:
    secret = tmp_path / "db_password"
    secret.write_text("x", encoding="utf-8")
    set_env(DB_PASSWORD_FILE=str(secret))
    with pytest.raises(ConfigError, match="not both"):
        load_config()


def test_reports_an_unreadable_password_file() -> None:
    os.environ.update({key: value for key, value in BASE_ENV.items() if key != "DB_PASSWORD"})
    os.environ["DB_PASSWORD_FILE"] = "/nonexistent/db_password"
    with pytest.raises(ConfigError, match="Cannot read"):
        load_config()


def test_rejects_a_non_numeric_port() -> None:
    set_env(DB_PORT="not-a-number")
    with pytest.raises(ConfigError, match="whole number"):
        load_config()


def test_rejects_an_out_of_range_value() -> None:
    set_env(WORKER_MAX_ATTEMPTS="0")
    with pytest.raises(ConfigError, match="between"):
        load_config()


def test_treats_whitespace_as_unset() -> None:
    set_env(WORKER_POLL_INTERVAL_SECONDS="   ")
    assert load_config().poll_interval_seconds == 5


def test_geocoder_user_agent_is_absent_by_default() -> None:
    # The geocoding job refuses to run without one rather than sending
    # anonymous traffic to Nominatim.
    set_env()
    assert load_config().geocoder_user_agent is None
