#!/bin/sh
# Installs the pinned pandoc release, verified against a recorded digest.
#
# CI must run the same pandoc the container ships, because the end-to-end
# citation test is the only thing that checks Chicago output end to end and it
# is worth nothing if it validates a different binary than production. The
# version and digests here are the same ones the Dockerfile uses -- change
# both together.
set -eu

PANDOC_VERSION="${PANDOC_VERSION:-3.1.3}"

# sha256 of pandoc-<version>-1-<arch>.deb from https://github.com/jgm/pandoc.
PANDOC_SHA256_AMD64="caa7e0410f9e2cb1da2eb8db13cc97b5548fe455985e2c944e3929d22f99bcdc"
PANDOC_SHA256_ARM64="b93cc370f2bf5e360aa2aa72019eda8aaf374dfff125bebf950470b22f7ac7e4"

arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64) sha256="$PANDOC_SHA256_AMD64" ;;
  arm64) sha256="$PANDOC_SHA256_ARM64" ;;
  # Failing loudly beats silently falling back to the distribution package,
  # which would reintroduce the version skew this exists to remove.
  *) echo "no pinned pandoc for architecture: $arch" >&2; exit 1 ;;
esac

deb="$(mktemp -d)/pandoc.deb"
url="https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-${arch}.deb"

curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$deb"
echo "${sha256}  ${deb}" | sha256sum -c -

sudo dpkg --install "$deb"
rm -f "$deb"

pandoc --version | head -n 1
