#!/usr/bin/env bash
# Notarize a packaged macOS preview artifact via notarytool, with retries.
#
# Why this exists: electron-builder's built-in `mac.notarize` makes exactly one
# notarytool submission attempt. Apple's Notary Service intermittently returns
# HTTP 500 (see issue #124), which kills the whole build. The preview workflow
# therefore builds with `--config.mac.notarize=false` and delegates notarization
# to this script, which submits the DMG (so Apple issues tickets for both the
# disk image and the app inside), retries transient failures with backoff, then
# staples the tickets onto the .app and .dmg and re-zips the artifact.
#
# Usage: notarize-macos-preview.sh <arm64|x64>
#
# Required env: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
set -euo pipefail

if (( $# != 1 )); then
  printf 'Usage: %s <arm64|x64>\n' "$0" >&2
  exit 2
fi

arch="$1"
case "$arch" in
  arm64 | x64) ;;
  *)
    printf 'Unsupported architecture: %s (expected arm64 or x64)\n' "$arch" >&2
    exit 2
    ;;
esac

: "${APPLE_ID:?APPLE_ID is required for notarization}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required for notarization}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required for notarization}"

shopt -s nullglob
dist="packages/desktop/dist"
zips=("$dist"/*-mac-preview-"$arch".zip)
dmgs=("$dist"/*-mac-preview-"$arch".dmg)

if (( ${#zips[@]} != 1 || ${#dmgs[@]} != 1 )); then
  printf 'Expected exactly one preview ZIP and one DMG for %s in %s, found %s ZIP(s) and %s DMG(s)\n' \
    "$arch" "$dist" "${#zips[@]}" "${#dmgs[@]}" >&2
  exit 1
fi
zip="${zips[0]}"
dmg="${dmgs[0]}"

max_attempts=4
delays=(60 300 900) # seconds before attempts 2, 3 and 4
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
notarized=0
while (( attempt <= max_attempts )); do
  printf '\n=== Notarization attempt %s/%s: %s ===\n' "$attempt" "$max_attempts" "$dmg"
  status=0
  xcrun notarytool submit "$dmg" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait --timeout 15m \
    --output-format json >"$log" 2>&1 || status=$?

  # Never echo the app-specific password back into CI logs.
  grep -vF "$APPLE_APP_SPECIFIC_PASSWORD" "$log" || true

  if (( status == 0 )) && grep -Eq '"status"[[:space:]]*:[[:space:]]*"Accepted"' "$log"; then
    notarized=1
    break
  fi

  # Permanent failures: bad credentials/authorization (4xx) or a submission
  # Apple rejected for content reasons. Retrying cannot fix these.
  if grep -Eq 'HTTP status code: 4[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*"(Invalid|Rejected)"' "$log"; then
    submission_id="$(grep -Eo '"id"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]+"' "$log" | head -1 | sed 's/.*: *"//; s/"$//')"
    if [[ -n "$submission_id" ]]; then
      printf '\nFetching notarization log for rejected submission %s...\n' "$submission_id"
      xcrun notarytool log "$submission_id" \
        --apple-id "$APPLE_ID" \
        --password "$APPLE_APP_SPECIFIC_PASSWORD" \
        --team-id "$APPLE_TEAM_ID" || true
    fi
    printf '\nPermanent notarization failure (exit %s) — not retrying.\n' "$status" >&2
    exit 1
  fi

  if (( attempt >= max_attempts )); then
    printf '\nNotarization still failing after %s attempts — giving up.\n' "$max_attempts" >&2
    exit 1
  fi

  delay="${delays[$((attempt - 1))]}"
  printf 'Transient failure (exit %s) — retrying in %ss...\n' "$status" "$delay"
  sleep "$delay"
  attempt=$((attempt + 1))
done

if (( notarized != 1 )); then
  printf 'Notarization did not succeed.\n' >&2
  exit 1
fi

# Staple the ticket to the unpacked .app, then re-create the artifact ZIP so
# the uploaded artifact contains the stapled app.
apps=()
while IFS= read -r -d '' app; do
  apps+=("$app")
done < <(find "$dist" -type d -name 'omp-ui.app' -prune -print0)

if (( ${#apps[@]} != 1 )); then
  printf 'Expected exactly one unpacked omp-ui.app in %s, found %s\n' "$dist" "${#apps[@]}" >&2
  exit 1
fi
app="${apps[0]}"

xcrun stapler staple "$app"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
printf 'Re-zipped stapled app into %s\n' "$zip"

xcrun stapler staple "$dmg"

printf 'Notarization and stapling complete for %s.\n' "$arch"
