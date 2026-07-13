#!/usr/bin/env bash
#
# Generates latest.json for the Tauri updater plugin.
# Run after `pnpm tauri build` with TAURI_SIGNING_PRIVATE_KEY set.
#
# Usage: bash scripts/generate-update-json.sh
#
set -euo pipefail

VERSION=$(jq -r .version src-tauri/tauri.conf.json)

# Locate the signed update artifact
BUNDLE_DIR="src-tauri/target/release/bundle/macos"
SIG_FILE="${BUNDLE_DIR}/shep.app.tar.gz.sig"

if [ ! -f "$SIG_FILE" ]; then
  echo "Error: Signature file not found at ${SIG_FILE}"
  echo "Make sure TAURI_SIGNING_PRIVATE_KEY is set before building."
  exit 1
fi

SIGNATURE=$(cat "$SIG_FILE")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DOWNLOAD_URL="https://github.com/mitja/shep/releases/download/v${VERSION}/shep.app.tar.gz"

cat > latest.json <<EOF
{
  "version": "${VERSION}",
  "notes": "See release notes on GitHub",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "${DOWNLOAD_URL}"
    }
  }
}
EOF

echo "Generated latest.json for v${VERSION}"
