#!/usr/bin/env bash
# Builds Dash Lite for Windows, macOS and Linux into ./dist (Go ≥ 1.22, Python 3).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(grep -oP 'appVersion = "\K[^"]+' server.go)
OUT=dist
rm -rf "$OUT" && mkdir -p "$OUT"
LD="-s -w"
export CGO_ENABLED=0

echo "→ Windows"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LD -H windowsgui" -o "$OUT/DashLite-Windows-x64.exe" .
GOOS=windows GOARCH=arm64 go build -trimpath -ldflags "$LD -H windowsgui" -o "$OUT/DashLite-Windows-ARM64.exe" .

echo "→ macOS (universelle Intel + Apple Silicon)"
tmp=$(mktemp -d)
GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "$LD" -o "$tmp/amd64" .
GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$LD" -o "$tmp/arm64" .
APP="$tmp/Dash Lite.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
python3 build/fat.py "$APP/Contents/MacOS/DashLite" "$tmp/amd64" "$tmp/arm64"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"
sed "s/__VERSION__/$VERSION/g" build/Info.plist > "$APP/Contents/Info.plist"
python3 build/zipapp.py "$OUT/DashLite-macOS.zip" "$APP"

echo "→ Linux"
for arch in amd64 arm64; do
  GOOS=linux GOARCH=$arch go build -trimpath -ldflags "$LD" -o "$tmp/linux-$arch/DashLite" .
  cp build/icon-256.png "$tmp/linux-$arch/dashlite.png"
  tar -C "$tmp/linux-$arch" -czf "$OUT/DashLite-Linux-$([ $arch = amd64 ] && echo x64 || echo ARM64).tar.gz" DashLite dashlite.png
done
rm -rf "$tmp"
ls -lh "$OUT"
