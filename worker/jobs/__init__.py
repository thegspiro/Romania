"""Job handlers.

Each module exposes `run(connection, config, payload)`. A handler that raises
is retried by the runner with backoff; one that returns is marked succeeded.
Handlers must therefore be idempotent: a retry after a partial success has to
be safe.
"""
