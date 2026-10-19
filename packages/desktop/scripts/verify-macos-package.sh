#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 2 )); then
  printf 'Usage: %s <arm64|x64> [full|signed-only]\n' "$0" >&2
  exit 2
fi

arch="$1"
mode="${2:-full}"
case "$arch" in
  arm64)
    required_arch=arm64
    forbidden_arch=x86_64
    ;;
  x64)
    required_arch=x86_64
    forbidden_arch=arm64
    ;;
  *)
    printf 'Unsupported architecture: %s (expected arm64 or x64)\n' "$arch" >&2
    exit 2
    ;;
esac
case "$mode" in
  full | signed-only) ;;
  *)
    printf 'Unsupported mode: %s (expected full or signed-only)\n' "$mode" >&2
    exit 2
    ;;
esac

shopt -s nullglob
dist="packages/desktop/dist"
dmgs=("$dist"/*-mac-"$arch".dmg)
zips=("$dist"/*-mac-"$arch".zip)

if (( ${#dmgs[@]} != 1 )); then
  printf 'Expected exactly one %s DMG, found %s\n' "$arch" "${#dmgs[@]}" >&2
  printf 'DMG candidates: %s\n' "${dmgs[*]:-none}" >&2
  exit 1
fi
if (( ${#zips[@]} != 1 )); then
  printf 'Expected exactly one %s ZIP, found %s\n' "$arch" "${#zips[@]}" >&2
  printf 'ZIP candidates: %s\n' "${zips[*]:-none}" >&2
  exit 1
fi

apps=()
while IFS= read -r -d '' app; do
  apps+=("$app")
done < <(find "$dist" -type d -name 'omp-ui.app' -prune -print0)
if (( ${#apps[@]} != 1 )); then
  printf 'Expected exactly one unpacked omp-ui.app, found %s\n' "${#apps[@]}" >&2
  printf 'App candidates: %s\n' "${apps[*]:-none}" >&2
  exit 1
fi

app="${apps[0]}"
executable="$app/Contents/MacOS/omp-ui"
pty="$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}/pty.node"
test -f "$executable" || { printf 'Missing app executable: %s\n' "$executable" >&2; exit 1; }
test -f "$pty" || { printf 'Missing unpacked node-pty binary: %s\n' "$pty" >&2; exit 1; }
helper="$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper"
# The npm prebuild stores the helper mode 0644; the afterPack hook must have
# OR'd in the exec bit, or every PTY spawn in the app fails (issue #489).
test -x "$helper" || { printf 'node-pty spawn-helper is not executable: %s\n' "$helper" >&2; exit 1; }

for binary in "$executable" "$pty"; do
  description="$(file -b "$binary")"
  if [[ "$description" != *Mach-O* || "$description" != *"$required_arch"* || "$description" == *"$forbidden_arch"* ]]; then
    printf 'Expected thin %s Mach-O binary at %s, got: %s\n' "$required_arch" "$binary" "$description" >&2
    exit 1
  fi
done

: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required for signature verification}"
# Trim whitespace/newlines that may be present in the secret value.
expected_team="$(printf '%s' "$APPLE_TEAM_ID" | tr -d '[:space:]')"

codesign --verify --deep --strict --verbose=2 "$app"
signature="$(codesign -dv --verbose=4 "$app" 2>&1)"
printf '%s\n' "$signature"
grep -Fq "Authority=Developer ID Application:" <<<"$signature" || {
  printf 'App is not signed with a Developer ID Application identity\n' >&2
  exit 1
}
actual_team="$(sed -n 's/^TeamIdentifier=//p' <<<"$signature" | head -1 | tr -d '[:space:]')"
if [[ -z "$actual_team" || "$actual_team" != "$expected_team" ]]; then
  printf 'Signing team mismatch: signature has "%s", APPLE_TEAM_ID has length %s\n' \
    "$actual_team" "${#expected_team}" >&2
  exit 1
fi
codesign --verify --strict --verbose=2 "$pty"
# Gatekeeper assessment and stapling only hold for notarized artifacts; a
# signed-only build (Apple Notary Service outage — issue #124) is still
# verified for signature integrity, identity, and team.
# `stapler validate` performs its own online ticket-delivery lookup against
# Apple's CloudKit endpoint; a transient network drop there (NSURLErrorDomain
# Code=-1005, "The validate action failed! Error 68.") must not kill the lane
# after notarization was already Accepted and both staples reported worked
# (#879). Same schedule as the #856 staple retry in notarize-macos.sh; every
# post-acceptance validation failure is treated as transient — a permanently
# broken staple just exhausts the schedule. The constants are env-overridable
# for testing; CI leaves them unset, so the default schedule applies.
max_attempts="${VERIFY_MAX_ATTEMPTS:-4}"
read -r -a delays <<<"${VERIFY_RETRY_DELAYS:-60 300 900}" # seconds before attempts 2, 3 and 4

validate_with_retry() {
  local attempt=1 status delay
  while (( attempt <= max_attempts )); do
    printf '\n=== Validate attempt %s/%s: %s ===\n' "$attempt" "$max_attempts" "$*"
    status=0
    "$@" >&2 || status=$?
    if (( status == 0 )); then
      return 0
    fi
    if (( attempt >= max_attempts )); then
      printf '\nValidation still failing after %s attempts — giving up: %s\n' \
        "$max_attempts" "$*" >&2
      exit 1
    fi
    delay="${delays[$((attempt - 1))]}"
    printf 'Transient validation failure (exit %s) — retrying in %ss...\n' "$status" "$delay"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

if [[ "$mode" == "full" ]]; then
  spctl --assess --type execute --verbose=4 "$app"
  validate_with_retry xcrun stapler validate "$app"
else
  printf 'signed-only mode: skipping spctl assessment and stapler validation\n'
fi

dmg="${dmgs[0]##*/}"
zip="${zips[0]##*/}"
checksums="SHA256SUMS-macos-${arch}.txt"
(cd "$dist" && shasum -a 256 "$dmg" "$zip" > "$checksums")
