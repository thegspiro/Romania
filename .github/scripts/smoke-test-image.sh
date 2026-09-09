#!/bin/sh
# Proves a freshly built image is sound, without needing a database.
#
# --entrypoint is mandatory. scripts/entrypoint.sh calls wait-for-db.sh before
# its case statement, so it runs for every role including the fallthrough that
# execs an arbitrary command -- and wait-for-db.sh only short-circuits when
# mysqladmin is missing, which it is not. A plain `docker run` here would block
# for DB_WAIT_TIMEOUT and then exit 1.
#
# Everything below checks something no other job can: the node and python jobs
# test the source tree, not the artifact that gets deployed.
set -eu

image="${1:?usage: smoke-test-image.sh <image>}"

docker run --rm --entrypoint /bin/sh "$image" -c '
  set -eu

  # Never root. A path traversal or template injection is far cheaper to
  # contain as an unprivileged user, and USER node is easy to lose in a
  # refactor.
  test "$(id -u)" = "1000"

  # The export toolchain. Both are fetched from releases at build time, so a
  # wrong-architecture or truncated download is a build regression that would
  # otherwise surface the first time someone compiled a manuscript.
  pandoc --version | head -n 1
  tectonic --version
  command -v mysqldump >/dev/null

  # The worker venv and its PATH prepend. This is the only place the
  # Dockerfile pip list is exercised at all.
  python3 -c "import PIL, pypdfium2, pymysql, bibtexparser, rispy, requests"

  # copy-assets.mjs and vendor-assets.mjs run in the build stage; nothing else
  # checks their output survived COPY --from=build into the runtime image.
  test -f dist/index.js
  test -f dist/db/migrate.js
  test -d dist/views
  test -d dist/citations/styles
  test -f public/vendor/leaflet/leaflet.js
  test -f public/vendor/cytoscape/cytoscape.min.js

  # npm prune --omit=dev still pruning. Shipping a test runner and a compiler
  # to production is a real footgun, not a size complaint.
  test ! -d node_modules/vitest
  test ! -d node_modules/typescript

  # A non-executable entrypoint is a container that will not start, discovered
  # at deploy time.
  test -x scripts/entrypoint.sh
  test -x scripts/wait-for-db.sh
  test -x scripts/healthcheck.sh

  echo "image smoke test passed"
'
