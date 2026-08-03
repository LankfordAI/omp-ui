#!/bin/sh
# Assembles the omp-ui Flatpak bundle from the electron-builder unpacked
# tree, using flatpak build-init/build-finish/build-export/build-bundle
# only — no flatpak-builder and no bubblewrap — so it runs inside the
# containerized CI runners, which cannot create user namespaces (same
# approach as Voyager's ADR-0013 flatpak lane).
#
# Requires the runtimes below installed (user or system scope):
#   org.freedesktop.Platform//25.08
#   org.freedesktop.Sdk//25.08
#   org.electronjs.Electron2.BaseApp//25.08
#
# usage: assemble.sh UNPACKED_DIR OUTPUT_BUNDLE
set -eu

APP_ID=ai.lankford.omp-ui
RUNTIME_BRANCH=25.08
EXPORT_BRANCH=stable
HERE="$(dirname "$(readlink -f "$0")")"
UNPACKED="${1:?usage: assemble.sh UNPACKED_DIR OUTPUT_BUNDLE}"
OUTPUT="${2:?usage: assemble.sh UNPACKED_DIR OUTPUT_BUNDLE}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Initialize from the Electron base app (provides zypak, which layers the
# Chromium sandbox inside the Flatpak sandbox) and copy the unpacked
# application tree verbatim.
flatpak build-init --arch=x86_64 \
  --base=org.electronjs.Electron2.BaseApp --base-version="$RUNTIME_BRANCH" \
  "$WORK/build" "$APP_ID" org.freedesktop.Sdk org.freedesktop.Platform "$RUNTIME_BRANCH"
cp -a "$UNPACKED" "$WORK/build/files/main"
mkdir -p "$WORK/build/files/bin" "$WORK/build/files/share/applications"
install -m 755 "$HERE/omp-ui" "$WORK/build/files/bin/omp-ui"
install -m 644 "$HERE/$APP_ID.desktop" \
  "$WORK/build/files/share/applications/$APP_ID.desktop"

# Grant surface: omp-ui is a development tool that opens projects anywhere
# in the home directory and spawns PTY sessions; org.freedesktop.Flatpak
# lets those sessions reach the host via flatpak-spawn.
flatpak build-finish "$WORK/build" \
  --command=omp-ui \
  --share=network \
  --share=ipc \
  --socket=wayland \
  --socket=fallback-x11 \
  --device=dri \
  --filesystem=home \
  --talk-name=org.freedesktop.Flatpak

# --disable-sandbox only un-sandboxes the export-time validators, which
# would otherwise need bubblewrap. --runtime-repo lets flatpak resolve the
# runtime dependency at install time.
flatpak build-export --disable-sandbox --arch=x86_64 \
  "$WORK/repo" "$WORK/build" "$EXPORT_BRANCH"
flatpak build-bundle --arch=x86_64 \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  "$WORK/repo" "$OUTPUT" "$APP_ID" "$EXPORT_BRANCH"
echo "assemble: wrote $OUTPUT"
