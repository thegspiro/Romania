# syntax=docker/dockerfile:1
#
# One image, three roles.
#
# The web service, the Python worker and the export toolchain all live in this
# image and are selected by the entrypoint's first argument. That was a
# deliberate choice: it costs image size, but there is exactly one artifact to
# build, tag, scan and roll back, which on a single-operator deployment is
# worth more than the megabytes.
#
# Tectonic rather than a full TeX Live: TeX Live is 3-5 GB, Tectonic is around
# 150 MB and fetches only the packages a document actually uses.

#
# Both stages and the database in docker-compose.yml are pinned by digest, the
# same way pandoc and tectonic are below. A floating tag meant the image CI
# validated and the image a rebuild produced could be different base images,
# which is the one difference that never appears in a diff.
#
# The tag is kept alongside the digest: the digest is what Docker resolves, the
# tag is what tells a reader which release this is. Pinning freezes the base's
# security updates too, so refresh it deliberately -- the digest for a tag is:
#
#   docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
#
# Resolved 2026-09-12; both digests are multi-arch indexes covering linux/amd64
# and linux/arm64, which the CI matrix builds.

# --- Stage 1: build the TypeScript ------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of
# source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.typecheck.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public

RUN npm run build && npm prune --omit=dev


# --- Stage 2: runtime --------------------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# - python3 + venv: the background worker
# - default-mysql-client: mysqldump, used by the backup job
# - libjpeg/zlib/freetype: Pillow's image codecs
# - tini: PID 1 that reaps zombies and forwards signals
# - ca-certificates: outbound HTTPS for geocoding and Tectonic's package fetch
#
# pandoc and tectonic are NOT installed here -- both are pinned downloads
# below, for reasons recorded there.
RUN apt-get update && apt-get install --no-install-recommends -y \
      python3 \
      python3-venv \
      python3-pip \
      default-mysql-client \
      ca-certificates \
      tini \
      curl \
      libjpeg62-turbo \
      zlib1g \
      libfreetype6 \
      libopenjp2-7 \
      libtiff6 \
    && rm -rf /var/lib/apt/lists/*

# Pandoc renders every compiled manuscript, so its version decides what the
# citations in a finished dissertation look like. Debian bookworm ships 2.17;
# the test suite has only ever been green against 3.1.3. Taking the unpinned
# distribution package meant CI and production could validate and render with
# different binaries, which is the one place a silent difference would show up
# in a submitted document.
#
# Pinned and verified against a recorded digest. .github/scripts/install-pandoc.sh
# installs the same artifact in CI -- change the version in both together.
ARG PANDOC_VERSION=3.1.3
ARG PANDOC_SHA256_AMD64=caa7e0410f9e2cb1da2eb8db13cc97b5548fe455985e2c944e3929d22f99bcdc
ARG PANDOC_SHA256_ARM64=b93cc370f2bf5e360aa2aa72019eda8aaf374dfff125bebf950470b22f7ac7e4
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha256="$PANDOC_SHA256_AMD64" ;; \
      arm64) sha256="$PANDOC_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-${arch}.deb"; \
    curl -fsSL --retry 3 --retry-delay 2 "$url" -o /tmp/pandoc.deb; \
    echo "${sha256}  /tmp/pandoc.deb" | sha256sum -c -; \
    dpkg --install /tmp/pandoc.deb; \
    rm -f /tmp/pandoc.deb; \
    pandoc --version | head -n 1

# Tectonic is not packaged for Debian; install the released binary. Verified
# against a recorded digest for the same reason as pandoc: `tectonic --version`
# proves the file runs, which is not the same as proving it is the file that
# was published.
ARG TECTONIC_VERSION=0.15.0
ARG TECTONIC_SHA256_AMD64=dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407
ARG TECTONIC_SHA256_ARM64=1f59f9fb8eb65e8ba18658fc9016767e7d3e12488ded8b8fffa34254e51ce42c
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target="x86_64-unknown-linux-musl"; sha256="$TECTONIC_SHA256_AMD64" ;; \
      arm64) target="aarch64-unknown-linux-musl"; sha256="$TECTONIC_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${target}.tar.gz"; \
    curl -fsSL --retry 3 --retry-delay 2 "$url" -o /tmp/tectonic.tar.gz; \
    echo "${sha256}  /tmp/tectonic.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic; \
    rm -f /tmp/tectonic.tar.gz; \
    tectonic --version

WORKDIR /app

# Python dependencies into a virtualenv so they cannot collide with the
# distribution's system packages.
#
# The list is DERIVED from pyproject.toml rather than restated here. Two copies
# of a dependency list drift, and the drift is silent until something fails at
# runtime in the image but not in CI.
#
# Only [project].dependencies is read, so the dev extra (pytest, ruff) can
# never reach the production image. Written to a requirements file rather than
# expanded on the command line: the specifiers contain < and >, and a
# newline-separated file leaves no question about how the shell splits them.
#
# Deliberately not `pip install .`: the worker package is not installed at all,
# it is found on sys.path via WORKDIR /app. Installing it would ship a second
# copy and force COPY worker above this layer, busting the cache on every
# worker source edit.
COPY pyproject.toml ./
RUN python3 -m venv /opt/venv \
    && python3 -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))" \
         > /tmp/requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt
ENV PATH="/opt/venv/bin:${PATH}"

# The uid and gid the application runs as.
#
# The default is the base image's own `node` user, 1000:1000, so an unset build
# produces exactly the image it always did. They exist because a bind-mounted
# host directory carries the host's ownership and the container has to be able
# to write to it: on Unraid a share is owned by nobody:users, 99:100, and a
# directory created there over SSH is root:root 0755 -- neither of which a
# process running as 1000 can write to. Set them through docker-compose.yml,
# which reads APP_UID and APP_GID from .env.
#
# Done at build time rather than by starting as root and dropping privileges.
# There is no published image, so every deployment builds its own anyway and a
# host-specific uid costs nothing; the alternative would put a root entrypoint
# in front of every container to save a rebuild that already happens.
#
# Placed after the venv so changing them rebuilds only the layers below, and
# before the COPYs so `--chown=node:node` resolves to the adjusted ids rather
# than needing a second full copy of the tree to correct them.
#
# Two things the block gets right that are easy to get wrong:
#
#   - A gid that already exists is joined, not renamed. Debian ships gid 100 as
#     `users`, which is exactly the one Unraid uses, so groupmod would fail.
#   - A uid already held by another account is refused rather than shared via
#     usermod -o. Debian ships uid 100 as `_apt`, and two users behind one uid
#     is not a thing to discover later.
#
# The RUN carries no comments of its own: a `#` line inside a continued
# instruction is stripped by the Dockerfile parser before the shell sees it,
# and this file should not lean on that.
ARG APP_UID=1000
ARG APP_GID=1000
RUN set -eu; \
    current_uid="$(id -u node)"; \
    current_gid="$(id -g node)"; \
    if [ "$APP_GID" != "$current_gid" ]; then \
      if getent group "$APP_GID" >/dev/null 2>&1; then \
        usermod -g "$APP_GID" node; \
      else \
        groupmod -g "$APP_GID" node; \
      fi; \
    fi; \
    if [ "$APP_UID" != "$current_uid" ]; then \
      existing="$(getent passwd "$APP_UID" | cut -d: -f1 || true)"; \
      if [ -n "$existing" ]; then \
        echo "APP_UID=$APP_UID is already used by '$existing' in this image; pick another." >&2; \
        exit 1; \
      fi; \
      usermod -u "$APP_UID" node; \
    fi; \
    id node

# Application code. Ownership is set here rather than with a later chown, which
# would duplicate every file into a new layer.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node package.json ./
COPY --chown=node:node db ./db
COPY --chown=node:node worker ./worker
COPY --chown=node:node scripts ./scripts

RUN chmod +x scripts/*.sh

# Data directories, created here so the container also works without a bind
# mount (development, CI) rather than failing on first write.
RUN mkdir -p /data/files /data/backups && chown -R node:node /data

# Never run as root: a template injection or a path traversal is much cheaper
# to contain as an unprivileged user. Named rather than numeric so the uid keeps
# a passwd entry -- anything that calls getpwuid, or wants a HOME, still works.
USER node

EXPOSE 8080

# tini forwards SIGTERM so the graceful shutdown in src/index.ts actually runs.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
CMD ["web"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/app/scripts/healthcheck.sh"]
