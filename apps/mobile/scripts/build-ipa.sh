#!/usr/bin/env bash
#
# Build an App Store Connect .ipa locally with Xcode — no EAS credentials needed.
#
# Signing is Xcode "automatic" against the team in app.config.ts (ios.appleTeamId).
# `-allowProvisioningUpdates` lets xcodebuild use the Apple account signed in to
# Xcode (Xcode -> Settings -> Accounts) to register the bundle ID and fetch a
# cloud-managed distribution certificate + App Store profile on the fly.
#
# The native ios/ folder is generated (gitignored), so every run re-prebuilds it
# from app.config.ts; nothing hand-edited in ios/ survives.
#
# Output: build/water-run-<version>-<build>.ipa — drag it into Transporter, or run
# ./scripts/submit-testflight.sh (which picks the newest .ipa in build/).
#
# Usage:
#   ./scripts/build-ipa.sh
#
# Env:
#   BUILD_NUMBER  CFBundleVersion (default: YYYYMMDD.HHMM-ish, always increasing).
#                 App Store Connect rejects a build number it has already seen.
#   UPLOAD=1      also upload the archive to App Store Connect with the Xcode
#                 account. The app record for the bundle ID must already exist.

set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR="build"
ARCHIVE="$BUILD_DIR/WaterRun.xcarchive"
# Strip the leading zero from HHMM so each dot-separated part is a plain integer.
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d).$((10#$(date +%H%M)))}"
UPLOAD="${UPLOAD:-0}"

fail() {
  echo "error: $*" >&2
  exit 1
}

command -v xcodebuild >/dev/null || fail "xcodebuild not found — install Xcode"
xcodebuild -checkFirstLaunchStatus ||
  fail "Xcode setup incomplete. Run: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"

TEAM_ID="$(npx expo config --type public --json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).ios?.appleTeamId??""))')"
[[ -n "$TEAM_ID" ]] || fail "ios.appleTeamId is not set in app.config.ts"

echo "==> prebuilding ios/ from app.config.ts"
CI=1 npx expo prebuild --platform ios --clean

WORKSPACE="$(ls -d ios/*.xcworkspace | head -n1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
INFO_PLIST="ios/$SCHEME/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"

echo "==> version $VERSION, build $BUILD_NUMBER"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$INFO_PLIST"

rm -rf "$ARCHIVE" "$BUILD_DIR/export"
mkdir -p "$BUILD_DIR"

echo "==> archiving $SCHEME (Release) — full log: $BUILD_DIR/archive.log"
# The archive log runs to ~50k lines and the real error sits far above the
# closing "ARCHIVE FAILED", so keep it in a file and surface just the errors.
if ! xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  archive >"$BUILD_DIR/archive.log" 2>&1; then
  grep -nE "error:|^❌" "$BUILD_DIR/archive.log" | head -n 40 >&2 || true
  fail "archive failed — see $BUILD_DIR/archive.log"
fi

# destination=export writes the .ipa locally; destination=upload sends the
# archive straight to App Store Connect instead.
write_export_options() {
  cat >"$BUILD_DIR/ExportOptions-$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>$1</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST
}

echo "==> exporting .ipa"
write_export_options export
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$BUILD_DIR/export" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions-export.plist" \
  -allowProvisioningUpdates

IPA="$BUILD_DIR/water-run-$VERSION-$BUILD_NUMBER.ipa"
mv "$(ls "$BUILD_DIR"/export/*.ipa | head -n1)" "$IPA"
echo "==> built $(pwd)/$IPA"

if [[ "$UPLOAD" == "1" ]]; then
  echo "==> uploading to App Store Connect"
  write_export_options upload
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportPath "$BUILD_DIR/upload" \
    -exportOptionsPlist "$BUILD_DIR/ExportOptions-upload.plist" \
    -allowProvisioningUpdates
  echo "==> uploaded. Processing takes a few minutes; watch App Store Connect -> TestFlight."
fi
