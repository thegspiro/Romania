"""Geocoding for places, via Nominatim.

Historical geography does not map cleanly onto a modern gazetteer: borders
moved, towns were renamed, and some places no longer exist. So the result is
recorded with a precision marker and never overwrites coordinates that were
entered by hand -- an automatic lookup must not silently replace a
researcher's own judgement about where something was.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import pymysql
import requests

from worker.config import Config
from worker.db import fetch_one, transaction

LOGGER = logging.getLogger("worker.geocode")

# Nominatim's usage policy allows at most one request per second.
MIN_REQUEST_INTERVAL_SECONDS = 1.0
REQUEST_TIMEOUT_SECONDS = 20

_last_request_at = 0.0

# Nominatim's `type` mapped to how precisely it locates something.
PRECISION_BY_CLASS: dict[str, str] = {
    "house": "exact",
    "building": "exact",
    "address": "exact",
    "amenity": "exact",
    "village": "approximate",
    "town": "approximate",
    "city": "approximate",
    "hamlet": "approximate",
    "suburb": "approximate",
    "county": "region",
    "state": "region",
    "region": "region",
    "country": "region",
}


class GeocodingUnavailable(RuntimeError):
    """Raised when the geocoder cannot be used at all, as opposed to a miss."""


def run(
    connection: pymysql.connections.Connection,
    config: Config,
    payload: dict[str, Any],
) -> None:
    content_item_id = payload.get("contentItemId")
    if not isinstance(content_item_id, int):
        raise ValueError("payload.contentItemId must be an integer")

    if not config.geocoder_user_agent:
        # Nominatim blocks clients that do not identify themselves, and
        # sending anonymous traffic would be both rude and futile.
        raise GeocodingUnavailable(
            "GEOCODER_USER_AGENT is not set. Nominatim requires a contact address; "
            "set it to something like 'dissertation-platform/0.1 (you@example.org)'."
        )

    place = fetch_one(
        connection,
        """
        SELECT ci.id, ci.title, pd.latitude, pd.longitude, pd.country_code
          FROM content_item ci
          JOIN place_detail pd ON pd.content_item_id = ci.id
         WHERE ci.id = %s AND ci.kind = 'place'
        """,
        (content_item_id,),
    )
    if place is None:
        LOGGER.info("place %s no longer exists, skipping", content_item_id)
        return

    if place["latitude"] is not None and not payload.get("force", False):
        LOGGER.info("place %s already has coordinates, skipping", content_item_id)
        return

    query = str(payload.get("query") or place["title"] or "").strip()
    if query == "":
        raise ValueError(f"place {content_item_id} has nothing to search for")

    result = _search(config, query, str(place["country_code"] or "") or None)
    if result is None:
        LOGGER.warning("no geocoding result for %r (place %s)", query, content_item_id)
        with transaction(connection) as cursor:
            # Record the attempt so the place is not retried on every sweep.
            cursor.execute(
                """
                UPDATE place_detail
                   SET geocoded_at = NOW(3), geocode_precision = 'unknown'
                 WHERE content_item_id = %s
                """,
                (content_item_id,),
            )
        return

    latitude, longitude, precision = result
    with transaction(connection) as cursor:
        cursor.execute(
            """
            UPDATE place_detail
               SET latitude = %s,
                   longitude = %s,
                   geocode_precision = %s,
                   geocoded_at = NOW(3)
             WHERE content_item_id = %s
            """,
            (latitude, longitude, precision, content_item_id),
        )
    LOGGER.info(
        "geocoded place %s to %s, %s (%s)", content_item_id, latitude, longitude, precision
    )


def _search(
    config: Config, query: str, country_code: str | None
) -> tuple[float, float, str] | None:
    global _last_request_at  # noqa: PLW0603 - module-level rate limit is intentional

    elapsed = time.monotonic() - _last_request_at
    if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
        time.sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)

    params: dict[str, str] = {"q": query, "format": "jsonv2", "limit": "1"}
    if country_code:
        params["countrycodes"] = country_code.lower()

    response = requests.get(
        f"{config.geocoder_base_url.rstrip('/')}/search",
        params=params,
        headers={"User-Agent": config.geocoder_user_agent or ""},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    _last_request_at = time.monotonic()

    if response.status_code == 429:
        raise GeocodingUnavailable("geocoder rate limit exceeded")
    response.raise_for_status()

    results = response.json()
    if not isinstance(results, list) or not results:
        return None

    first = results[0]
    try:
        latitude = float(first["lat"])
        longitude = float(first["lon"])
    except (KeyError, TypeError, ValueError):
        return None

    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None

    kind = str(first.get("addresstype") or first.get("type") or "")
    precision = PRECISION_BY_CLASS.get(kind, "approximate")
    return latitude, longitude, precision
