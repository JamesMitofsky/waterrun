#!/usr/bin/env bash
#
# Upload a local iOS .ipa to TestFlight (App Store Connect) non-interactively.
#
# Uses Apple's own `xcrun altool` with an App Store Connect API key — no Apple ID
# login, no 2FA prompts, so it runs unattended in a script or CI.
#
# Prerequisites (one-time):
#   1. Build an App Store distribution .ipa (NOT a dev-client build):
#        pnpm --filter @water-run/mobile ios:prod-build:testflight
#      A dev-client / ad-hoc .ipa uploads but is useless to testers.
#   2. Create an App Store Connect API key:
#        App Store Connect -> Users and Access -> Integrations -> App Store Connect API
#      Download the AuthKey_XXXXXX.p8 ONCE (Apple won't let you re-download it).
#   3. Export these before running (e.g. from an untracked .env you source):
#        ASC_KEY_ID     - the key's Key ID       (e.g. 2X9R4HXF34)
#        ASC_ISSUER_ID  - the Issuer ID (UUID)   (top of the Integrations page)
#        ASC_KEY_PATH   - path to the .p8 file
#
# Usage:
#   ./scripts/submit-testflight.sh [path/to/app.ipa]
#
# With no argument it uploads the newest *.ipa under ./build (adjust BUILD_DIR).

set -euo pipefail

BUILD_DIR="${BUILD_DIR:-build}"

fail() {
  echo "error: $*" >&2
  exit 1
}

# --- resolve the .ipa -------------------------------------------------------
IPA="${1:-}"
if [[ -z "$IPA" ]]; then
  IPA="$(ls -t "$BUILD_DIR"/*.ipa 2>/dev/null | head -n1 || true)"
  [[ -n "$IPA" ]] || fail "no .ipa given and none found in $BUILD_DIR/. Pass one: $0 path/to/app.ipa"
fi
[[ -f "$IPA" ]] || fail "ipa not found: $IPA"

# --- validate credentials ---------------------------------------------------
: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API Key ID)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect API Issuer ID)}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH (path to AuthKey_*.p8)}"
[[ -f "$ASC_KEY_PATH" ]] || fail "API key file not found: $ASC_KEY_PATH"

command -v xcrun >/dev/null || fail "xcrun not found — install Xcode command line tools"

# altool discovers the private key by name in a set of well-known dirs. Place a
# copy where it looks, keyed by the Key ID it expects.
KEY_DIR="$HOME/.appstoreconnect/private_keys"
KEY_DEST="$KEY_DIR/AuthKey_${ASC_KEY_ID}.p8"
mkdir -p "$KEY_DIR"
if [[ ! -f "$KEY_DEST" ]] || ! cmp -s "$ASC_KEY_PATH" "$KEY_DEST"; then
  cp "$ASC_KEY_PATH" "$KEY_DEST"
  chmod 600 "$KEY_DEST"
fi

# --- validate then upload ---------------------------------------------------
echo "==> validating $IPA"
xcrun altool --validate-app \
  --type ios \
  --file "$IPA" \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID"

echo "==> uploading $IPA to TestFlight"
xcrun altool --upload-app \
  --type ios \
  --file "$IPA" \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID"

echo "==> done. Processing takes a few minutes; watch App Store Connect -> TestFlight."
