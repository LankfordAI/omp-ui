#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  printf 'Usage: %s <arm64|x64>\n' "$0" >&2
  exit 2
fi

arch="$1"
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
pty="$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"
test -f "$executable" || { printf 'Missing app executable: %s\n' "$executable" >&2; exit 1; }
test -f "$pty" || { printf 'Missing unpacked node-pty binary: %s\n' "$pty" >&2; exit 1; }

for binary in "$executable" "$pty"; do
  description="$(file -b "$binary")"
  if [[ "$description" != *Mach-O* || "$description" != *"$required_arch"* || "$description" == *"$forbidden_arch"* ]]; then
    printf 'Expected thin %s Mach-O binary at %s, got: %s\n' "$required_arch" "$binary" "$description" >&2
    exit 1
  fi
done

: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required for signature verification}"

codesign --verify --deep --strict --verbose=2 "$app"
signature="$(codesign -dv --verbose=4 "$app" 2>&1)"
printf '%s\n' "$signature"
grep -Fq "Authority=Developer ID Application:" <<<"$signature" || {
  printf 'App is not signed with a Developer ID Application identity\n' >&2
  exit 1
}
grep -Fq "TeamIdentifier=$APPLE_TEAM_ID" <<<"$signature" || {
  printf 'Expected signing team %s\n' "$APPLE_TEAM_ID" >&2
  exit 1
}
codesign --verify --strict --verbose=2 "$pty"
spctl --assess --type execute --verbose=4 "$app"
xcrun stapler validate "$app"

dmg="${dmgs[0]##*/}"
zip="${zips[0]##*/}"
checksums="SHA256SUMS-macos-${arch}.txt"
(cd "$dist" && shasum -a 256 "$dmg" "$zip" > "$checksums")
