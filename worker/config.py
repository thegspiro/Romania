"""Worker configuration.

Reads the same environment variables as the web service, so one .env file
configures both and there is no second place for the database credentials to
drift out of sync.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class ConfigError(Exception):
    """Raised when the environment is missing or malformed."""


def _read(name: str, default: str | None = None) -> str | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip()


def _read_secret(name: str) -> str | None:
    """Resolves a secret from NAME or NAME_FILE.

    The _FILE form keeps credentials out of the process environment, where
    they would be visible in `docker inspect` and in crash dumps.
    """
    direct = _read(name)
    path = _read(f"{name}_FILE")

    if direct is not None and path is not None:
        raise ConfigError(f"Set either {name} or {name}_FILE, not both.")
    if path is None:
        return direct

    try:
        value = Path(path).read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ConfigError(f"Cannot read {name}_FILE at {path}: {error}") from error
    if value == "":
        raise ConfigError(f"{name}_FILE points at {path}, which is empty.")
    return value


def _read_bool(name: str, *, default: bool) -> bool:
    """Reads a boolean the same way the TypeScript side does."""
    raw = _read(name)
    if raw is None or raw == "":
        return default
    lowered = raw.strip().lower()
    if lowered in ("1", "true", "yes", "on"):
        return True
    if lowered in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{name} must be a boolean, got {raw!r}.")


def _read_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = _read(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}") from error
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


@dataclass(frozen=True)
class Config:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str

    poll_interval_seconds: int
    max_attempts: int
    batch_size: int
    """A job still marked running after this long is assumed to have died with
    its worker and is returned to the queue."""
    stale_lock_minutes: int

    storage_root: Path
    backup_root: Path

    geocoder_base_url: str
    geocoder_user_agent: str | None

    log_level: str

    # Defaulted, and last, so that adding them did not change the constructor
    # every existing caller and test already uses. Zotero sync is off until
    # both the library and the key are set.
    zotero_base_url: str = "https://api.zotero.org"
    zotero_library_type: str = "user"
    zotero_library_id: str | None = None
    zotero_api_key: str | None = None

    # Where file bytes live. Mirrors STORAGE_BACKEND on the web side, and the
    # two must agree: the worker writes the derivatives the web service serves,
    # so a worker still on `local` while the web app reads `s3` produces
    # thumbnails nothing can find.
    #
    # Defaulted, and here rather than beside storage_root, for the reason the
    # Zotero fields are: adding them must not change the constructor every
    # existing caller and test already uses.
    storage_backend: str = "local"
    s3_bucket: str = ""
    s3_region: str = "us-east-1"
    s3_endpoint: str = ""
    s3_force_path_style: bool = False
    s3_prefix: str = ""
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""

    @property
    def zotero_configured(self) -> bool:
        return self.zotero_library_id is not None and self.zotero_api_key is not None


def load_config() -> Config:
    password = _read_secret("DB_PASSWORD")
    if password is None:
        raise ConfigError("DB_PASSWORD (or DB_PASSWORD_FILE) is required.")

    library_type = (_read("ZOTERO_LIBRARY_TYPE", "user") or "user").lower()
    if library_type not in ("user", "group"):
        raise ConfigError(
            f"ZOTERO_LIBRARY_TYPE must be 'user' or 'group', got {library_type!r}."
        )

    storage_backend = (_read("STORAGE_BACKEND", "local") or "local").lower()
    if storage_backend not in ("local", "s3"):
        raise ConfigError(
            f"STORAGE_BACKEND must be 'local' or 's3', got {storage_backend!r}."
        )
    s3_endpoint = _read("S3_ENDPOINT", "") or ""
    if storage_backend == "s3" and not (_read("S3_BUCKET", "") or "").strip():
        # Same refusal the web service makes, for the same reason: a worker
        # that starts without a bucket fails on the first derivative it tries
        # to write, long after the misconfiguration.
        raise ConfigError("S3_BUCKET is required when STORAGE_BACKEND is s3.")

    library_id = _read("ZOTERO_LIBRARY_ID")
    if library_id is not None and not library_id.isdigit():
        # Zotero library ids are numeric. Catching it here beats discovering it
        # as a 404 from the API halfway through a sync.
        raise ConfigError(f"ZOTERO_LIBRARY_ID must be numeric, got {library_id!r}.")

    return Config(
        db_host=_read("DB_HOST", "db") or "db",
        db_port=_read_int("DB_PORT", 3306, 1, 65535),
        db_name=_read("DB_NAME", "dissertation") or "dissertation",
        db_user=_read("DB_USER", "dissertation") or "dissertation",
        db_password=password,
        poll_interval_seconds=_read_int("WORKER_POLL_INTERVAL_SECONDS", 5, 1, 3600),
        max_attempts=_read_int("WORKER_MAX_ATTEMPTS", 5, 1, 100),
        batch_size=_read_int("WORKER_BATCH_SIZE", 1, 1, 50),
        stale_lock_minutes=_read_int("WORKER_STALE_LOCK_MINUTES", 30, 1, 1440),
        storage_root=Path(_read("STORAGE_ROOT", "/data/files") or "/data/files"),
        backup_root=Path(_read("BACKUP_ROOT", "/data/backups") or "/data/backups"),
        storage_backend=storage_backend,
        s3_bucket=_read("S3_BUCKET", "") or "",
        s3_region=_read("S3_REGION", "us-east-1") or "us-east-1",
        s3_endpoint=s3_endpoint,
        s3_force_path_style=_read_bool(
            "S3_FORCE_PATH_STYLE", default=s3_endpoint != ""
        ),
        s3_prefix=_read("S3_PREFIX", "") or "",
        s3_access_key_id=_read("S3_ACCESS_KEY_ID", "") or "",
        s3_secret_access_key=_read_secret("S3_SECRET_ACCESS_KEY") or "",
        geocoder_base_url=(
            _read("GEOCODER_BASE_URL", "https://nominatim.openstreetmap.org")
            or "https://nominatim.openstreetmap.org"
        ),
        geocoder_user_agent=_read("GEOCODER_USER_AGENT"),
        zotero_base_url=(
            _read("ZOTERO_BASE_URL", "https://api.zotero.org") or "https://api.zotero.org"
        ),
        zotero_library_type=library_type,
        zotero_library_id=library_id,
        zotero_api_key=_read_secret("ZOTERO_API_KEY"),
        log_level=(_read("LOG_LEVEL", "info") or "info").upper(),
    )
