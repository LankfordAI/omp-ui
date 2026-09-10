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
dmgs=("$dist"/*-mac-preview-"$arch".dmg)
zips=("$dist"/*-mac-preview-"$arch".zip)

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
version="$(node -p 'require("./packages/desktop/package.json").version')"
# The embedded persistent host seed (issue #442 §10.1), one version directory.
seed="$app/Contents/Resources/host/$version"
host_bin="$seed/bin/omp-ui"
pty="$seed/lib/node-pty/build/Release/pty.node"
browser_manifest="$seed/resources/plan-verifier/browser.manifest.json"
test -f "$executable" || { printf 'Missing app executable: %s\n' "$executable" >&2; exit 1; }
test -d "$seed" || { printf 'Missing embedded host seed: %s\n' "$seed" >&2; exit 1; }
test -f "$host_bin" || { printf 'Missing embedded host executable: %s\n' "$host_bin" >&2; exit 1; }
test -f "$pty" || { printf 'Missing embedded host node-pty binary: %s\n' "$pty" >&2; exit 1; }
test -f "$browser_manifest" || { printf 'Missing embedded verifier browser manifest: %s\n' "$browser_manifest" >&2; exit 1; }
test -f "$seed/service/ai.lankford.omp-ui.host.plist" || { printf 'Missing embedded LaunchAgent definition under %s/service\n' "$seed" >&2; exit 1; }

for binary in "$executable" "$host_bin" "$pty"; do
  description="$(file -b "$binary")"
  if [[ "$description" != *Mach-O* || "$description" != *"$required_arch"* || "$description" == *"$forbidden_arch"* ]]; then
    printf 'Expected thin %s Mach-O binary at %s, got: %s\n' "$required_arch" "$binary" "$description" >&2
    exit 1
  fi
done

# The host refuses a verifier browser whose bytes differ from its manifest, so
# signing must have left the vendored Chrome alone (mac.signIgnore).
browser_exec="$(node -p 'require(process.argv[1]).executable' "$browser_manifest")"
browser_sha="$(node -p 'require(process.argv[1]).sha256' "$browser_manifest")"
actual_sha="$(shasum -a 256 "$seed/resources/plan-verifier/$browser_exec" | cut -d' ' -f1)"
if [[ "$actual_sha" != "$browser_sha" ]]; then
  printf 'Embedded verifier browser hash %s differs from its manifest %s: packaging altered the binary\n' "$actual_sha" "$browser_sha" >&2
  exit 1
fi

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
codesign --verify --strict --verbose=2 "$host_bin"
host_signature="$(codesign -dv --verbose=4 "$host_bin" 2>&1)"
grep -Fq "Authority=Developer ID Application:" <<<"$host_signature" || {
  printf 'Embedded host executable is not signed with a Developer ID Application identity\n' >&2
  exit 1
}
# Gatekeeper assessment and stapling only hold for notarized artifacts; a
# signed-only preview (Apple Notary Service outage — issue #124) is still
# verified for signature integrity, identity, and team.
if [[ "$mode" == "full" ]]; then
  spctl --assess --type execute --verbose=4 "$app"
  xcrun stapler validate "$app"
else
  printf 'signed-only mode: skipping spctl assessment and stapler validation\n'
fi

dmg="${dmgs[0]##*/}"
zip="${zips[0]##*/}"
checksums="SHA256SUMS-macos-${arch}.txt"
(cd "$dist" && shasum -a 256 "$dmg" "$zip" > "$checksums")
