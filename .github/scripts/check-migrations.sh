#!/bin/sh
# Refuses a change that edits or deletes a migration already on the base branch.
#
# CLAUDE.md: "Never edit an applied migration. The runner stores a checksum and
# will refuse to start." Today that is discovered at deploy, when the service
# will not come up. This catches it at review, where it costs a rewrite of one
# file instead of an outage.
#
# ADDING a migration is how the schema is meant to change, so additions pass.
# Only modifications and deletions fail.
set -eu

base="${1:?usage: check-migrations.sh <base-ref>}"

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "check-migrations: cannot resolve base ref '$base'" >&2
  echo "  the job needs fetch-depth: 0 so the base branch is present" >&2
  exit 1
fi

# Three dots: compare against the merge base, so commits that landed on the
# base branch after this one started are not mistaken for this change's work.
changed="$(git diff --name-only --diff-filter=MD "${base}...HEAD" -- db/migrations/)"

if [ -n "$changed" ]; then
  echo "An applied migration was modified or deleted:" >&2
  echo "$changed" | sed 's/^/  /' >&2
  cat >&2 <<'WHY'

The migration runner stores a checksum of every applied file and refuses to
start when one no longer matches, so this would fail at deploy rather than
here. Add a new numbered migration instead -- the schema is meant to move
forward, never to be rewritten underneath a database that already ran it.
WHY
  exit 1
fi

echo "no applied migration was modified"
