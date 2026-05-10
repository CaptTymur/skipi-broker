#!/usr/bin/env bash
# Publish the most recent Skipi Broker build to the local skipi-server's
# updater directory. Run AFTER `cargo tauri build`.
#
# Usage:  bash scripts/publish-build.sh
#
# Picks up version from src-tauri/tauri.conf.json, copies .deb / .AppImage
# (and their .sig files) into skipi-server/releases/broker/, regenerates
# latest.json so that running Skipi Broker instances see the new version
# on next startup.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES="$ROOT/../skipi-server/releases/broker"
mkdir -p "$RELEASES"

VERSION=$(grep -E '"version"' "$ROOT/src-tauri/tauri.conf.json" | head -1 | sed -E 's/.*"version"\s*:\s*"([^"]+)".*/\1/')
if [ -z "$VERSION" ]; then
  echo "could not detect version from tauri.conf.json" >&2
  exit 1
fi

BUNDLE="$ROOT/src-tauri/target/release/bundle"
DEB="$BUNDLE/deb/Skipi Broker_${VERSION}_amd64.deb"
DEB_SIG="${DEB}.sig"
APPIMAGE="$BUNDLE/appimage/Skipi Broker_${VERSION}_amd64.AppImage"
APPIMAGE_SIG="${APPIMAGE}.sig"

if [ ! -f "$APPIMAGE" ] || [ ! -f "$APPIMAGE_SIG" ]; then
  echo "missing AppImage or .sig for $VERSION" >&2
  echo "expected: $APPIMAGE" >&2
  echo "build first with:" >&2
  echo "  TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/skipi-broker.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD= cargo tauri build" >&2
  exit 1
fi

# Strip spaces from output filenames (URL-friendly).
DEB_OUT="Skipi-Broker_${VERSION}_amd64.deb"
DEB_SIG_OUT="${DEB_OUT}.sig"
APPIMAGE_OUT="Skipi-Broker_${VERSION}_amd64.AppImage"
SIG_OUT="${APPIMAGE_OUT}.sig"

cp "$APPIMAGE" "$RELEASES/$APPIMAGE_OUT"
cp "$APPIMAGE_SIG" "$RELEASES/$SIG_OUT"
[ -f "$DEB" ] && cp "$DEB" "$RELEASES/$DEB_OUT" || true
[ -f "$DEB_SIG" ] && cp "$DEB_SIG" "$RELEASES/$DEB_SIG_OUT" || true

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
APPIMAGE_SIGNATURE=$(cat "$RELEASES/$SIG_OUT")
DEB_SIGNATURE=""
if [ -f "$RELEASES/$DEB_SIG_OUT" ]; then
  DEB_SIGNATURE=$(cat "$RELEASES/$DEB_SIG_OUT")
fi
BASE_URL="${SKIPI_UPDATE_BASE:-https://api.skipi.app/broker/releases}"
# Note: api.skipi.app serves on standard 443 (xray REALITY removed; nginx
# took over 443 directly). Keep the URL port-less so the manifest is
# valid on both browsers and embedded fetchers.

if [ -n "$DEB_SIGNATURE" ]; then
  DEB_PLATFORM=$(cat <<JSON
    "linux-x86_64-deb": {
      "signature": "$DEB_SIGNATURE",
      "url": "$BASE_URL/$DEB_OUT"
    },
JSON
)
else
  DEB_PLATFORM=""
fi

cat > "$RELEASES/latest.json" <<JSON
{
  "version": "$VERSION",
  "pub_date": "$PUB_DATE",
  "notes": "Skipi Broker $VERSION",
  "platforms": {
${DEB_PLATFORM}
    "linux-x86_64": {
      "signature": "$APPIMAGE_SIGNATURE",
      "url": "$BASE_URL/$APPIMAGE_OUT"
    }
  }
}
JSON

echo "published $VERSION → $RELEASES"
echo "  deb       : $BASE_URL/$DEB_OUT"
echo "  appimage  : $BASE_URL/$APPIMAGE_OUT"
echo "  manifest  : $BASE_URL/latest.json (served as /broker/latest.json)"
