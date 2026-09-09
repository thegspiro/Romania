"""Database access for the worker.

Every statement uses parameter binding. PyMySQL's `%s` placeholders are bound
by the driver, not interpolated by us; building SQL with f-strings or `%`
formatting from any value is forbidden here as it is on the TypeScript side.

The one place SQL is assembled dynamically is the `IN (...)` list in
`runner.claim_jobs`, which emits only placeholders -- never values.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from worker.config import Config


def connect(config: Config) -> pymysql.connections.Connection:
    """Opens a connection with autocommit off, so job claiming is atomic."""
    return pymysql.connect(
        host=config.db_host,
        port=config.db_port,
        user=config.db_user,
        password=config.db_password,
        database=config.db_name,
        charset="utf8mb4",
        # Matches the collation the schema is created with, so string
        # comparisons behave identically to the web service.
        collation="utf8mb4_0900_ai_ci",
        cursorclass=DictCursor,
        autocommit=False,
        # Fail rather than hang forever if the database goes away mid-job.
        connect_timeout=10,
        read_timeout=120,
        write_timeout=60,
    )


@contextmanager
def transaction(connection: pymysql.connections.Connection) -> Iterator[DictCursor]:
    """Runs a block in a transaction, rolling back on any exception."""
    cursor = connection.cursor()
    try:
        yield cursor
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()


def fetch_one(
    connection: pymysql.connections.Connection,
    sql: str,
    params: tuple[Any, ...] = (),
) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchone()


def fetch_all(
    connection: pymysql.connections.Connection,
    sql: str,
    params: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return list(cursor.fetchall())


def execute(
    connection: pymysql.connections.Connection,
    sql: str,
    params: tuple[Any, ...] = (),
) -> int:
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        connection.commit()
        return cursor.rowcount
