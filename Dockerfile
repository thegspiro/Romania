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

# --- Stage 1: build the TypeScript ------------------------------------------
FROM node:22-bookworm-slim AS build

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
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# - python3 + venv: the background worker
# - default-mysql-client: mysqldump, used by the backup job
# - pandoc + tectonic: document export (PDF, DOCX, HTML, LaTeX)
# - libjpeg/zlib/freetype: Pillow's image codecs
# - tini: PID 1 that reaps zombies and forwards signals
# - ca-certificates: outbound HTTPS for geocoding and Tectonic's package fetch
RUN apt-get update && apt-get install --no-install-recommends -y \
      python3 \
      python3-venv \
      python3-pip \
      default-mysql-client \
      pandoc \
      ca-certificates \
      tini \
      curl \
      libjpeg62-turbo \
      zlib1g \
      libfreetype6 \
      libopenjp2-7 \
      libtiff6 \
    && rm -rf /var/lib/apt/lists/*

# Tectonic is not packaged for Debian; install the released binary. Pinned by
# version and checked for the expected binary rather than trusting the tarball
# blindly.
ARG TECTONIC_VERSION=0.15.0
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target="x86_64-unknown-linux-musl" ;; \
      arm64) target="aarch64-unknown-linux-musl" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${target}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/tectonic.tar.gz; \
    tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic; \
    rm -f /tmp/tectonic.tar.gz; \
    tectonic --version

WORKDIR /app

# Python dependencies into a virtualenv so they cannot collide with the
# distribution's system packages.
COPY pyproject.toml ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
       "PyMySQL>=1.1.1,<2" \
       "Pillow>=11.0.0,<12" \
       "pypdfium2>=4.30.0,<5" \
       "bibtexparser>=1.4.1,<2" \
       "rispy>=0.9.0,<1" \
       "requests>=2.32.3,<3"
ENV PATH="/opt/venv/bin:${PATH}"

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

# The `node` user ships with the base image as uid/gid 1000, which is what
# Unraid shares are normally owned by. Never run as root: a template injection
# or a path traversal is much cheaper to contain as an unprivileged user.
USER node

EXPOSE 8080

# tini forwards SIGTERM so the graceful shutdown in src/index.ts actually runs.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
CMD ["web"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/app/scripts/healthcheck.sh"]
