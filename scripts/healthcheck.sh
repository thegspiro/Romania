#!/bin/sh
#
# Container health check.
#
# Hits the application's own /healthz, which queries the database, so an
# unreachable database reports the container as unhealthy rather than leaving
# it "up" while serving errors.
set -eu

PORT="${HTTP_PORT:-8080}"

exec curl --fail --silent --show-error --max-time 4 \
  "http://127.0.0.1:${PORT}/healthz" >/dev/null
