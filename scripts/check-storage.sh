#!/bin/sh
#
# Fails the container when a data directory is not writable.
#
# Uploads create their directories lazily, on the first write, which means a
# bind mount the container cannot write to produces a healthy container that
# 500s the first time anybody saves a file. On Unraid that is the normal
# outcome of pointing STORAGE_ROOT at a share owned by a different uid, and it
# surfaces long after the install looked finished.
#
# Checking here turns that into a container that does not start, with a message
# naming the path and the uid to chown it to.
set -eu

fail() {
  printf 'check-storage: %s\n' "$1" >&2
  printf 'check-storage: the container runs as uid %s, gid %s -- on a bind mount, `chown -R %s:%s` the host path\n' \
    "$(id -u)" "$(id -g)" "$(id -u)" "$(id -g)" >&2
  exit 1
}

check_writable() {
  name="$1"
  path="$2"

  if ! mkdir -p "${path}" 2>/dev/null; then
    fail "${name} is ${path}, which does not exist and cannot be created"
  fi

  # An actual write, not a permission bit: ownership, a read-only mount and a
  # full filesystem all fail here and none of them show up in a mode test.
  #
  # The redirection runs in a subshell on purpose: a redirection that fails on
  # a special builtin is fatal to a POSIX shell, so writing this as a bare
  # `: >"$probe"` aborted the script with the shell's own message instead of
  # reaching the branch below.
  probe="${path}/.write-probe.$$"
  if ! (: >"${probe}") 2>/dev/null; then
    fail "${name} is ${path}, which exists but is not writable"
  fi
  rm -f "${probe}"
}

check_writable STORAGE_ROOT "${STORAGE_ROOT:-/data/files}"
check_writable BACKUP_ROOT "${BACKUP_ROOT:-/data/backups}"
