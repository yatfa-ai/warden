#!/usr/bin/env bash
# Build the warden companion binaries + manifest.
#
# Cross-compiles pure-Go (CGO_ENABLED=0) static binaries for linux/{amd64,arm64}
# into companion/dist/, strips them, bakes a version string into each binary via
# -ldflags, and writes companion/dist/manifest.json. The version is a hash of the
# Go source so it changes automatically when the companion changes; both the
# baked-in `main.version` (returned by the `ping` RPC) and the manifest agree on
# it — warden reads the manifest to pick the remote filename and uses a ping
# mismatch to detect + replace a stale cached binary on a host.
#
# Usage: companion/build.sh   (requires the Go toolchain on PATH, or GOROOT set)
set -euo pipefail

cd "$(dirname "$0")"

# Resolve `go` (honor GOROOT for environments like the worker sandbox where Go
# lives in a user-writable dir rather than /usr/local).
GO_BIN="${GO_BIN:-go}"
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
  if [ -n "${GOROOT:-}" ] && [ -x "${GOROOT}/bin/go" ]; then
    GO_BIN="${GOROOT}/bin/go"
  else
    echo "error: go toolchain not found on PATH (set GOROOT or GO_BIN)" >&2
    exit 1
  fi
fi

# Version = short hash of the companion source. Changes when main.go/go.mod do.
VER=$(cat main.go go.mod | sha256sum | cut -c1-12)

DIST="dist"
mkdir -p "$DIST"

for pair in linux/amd64 linux/arm64; do
  os="${pair%/*}"
  arch="${pair#*/}"
  out="$DIST/warden-companion-${os}-${arch}"
  echo "building ${out} (v${VER})"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 "$GO_BIN" build \
    -trimpath \
    -ldflags "-s -w -X main.version=${VER}" \
    -o "$out" .
done

cat > "$DIST/manifest.json" <<EOF
{
  "version": "${VER}",
  "binaries": {
    "linux/amd64": "warden-companion-linux-amd64",
    "linux/arm64": "warden-companion-linux-arm64"
  }
}
EOF

echo "built companion v${VER} -> ${DIST}/"
