#!/usr/bin/env bash
# Builds Dash Lite for Windows and Linux into ./dist (Go ≥ 1.22).
#   VERSION=1.2.0 ./build/build.sh   → version embedded in the binaries (default: value in server.go)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${VERSION:-$(sed -n 's/^var appVersion = "\(.*\)"/\1/p' server.go)}
OUT=dist
rm -rf "$OUT" && mkdir -p "$OUT"
LD="-s -w -X main.appVersion=$VERSION"
export CGO_ENABLED=0
echo "Dash Lite $VERSION"

echo "→ Windows"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LD -H windowsgui" -o "$OUT/DashLite-Windows-x64.exe" .
GOOS=windows GOARCH=arm64 go build -trimpath -ldflags "$LD -H windowsgui" -o "$OUT/DashLite-Windows-ARM64.exe" .

echo "→ Linux"
tmp=$(mktemp -d)
for arch in amd64 arm64; do
  name=$([ $arch = amd64 ] && echo x64 || echo ARM64)
  mkdir -p "$tmp/$arch"
  GOOS=linux GOARCH=$arch go build -trimpath -ldflags "$LD" -o "$tmp/$arch/DashLite" .
  cp build/icon-256.png "$tmp/$arch/dashlite.png"
  tar -C "$tmp/$arch" -czf "$OUT/DashLite-Linux-$name.tar.gz" DashLite dashlite.png
done
rm -rf "$tmp"

# checksums used by the auto-updater
(cd "$OUT" && sha256sum DashLite-* > SHA256SUMS)
ls -lh "$OUT"
