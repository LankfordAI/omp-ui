#!/usr/bin/env bash
# Install the omp-ui lite fleet member (issue #1010). v1: linux-x64 only.
# Env: OMP_UI_LITE_VERSION pin an exact version; OMP_UI_LITE_CHANNEL=nightly for the nightly train.
set -euo pipefail

BIN_NAME="omp-ui-lite"
REPO="LankfordAI/omp-ui"
CHANNEL="${OMP_UI_LITE_CHANNEL:-stable}"
DEST_BIN="${HOME}/.local/bin/${BIN_NAME}"
LIB_DIR="${HOME}/.local/lib/${BIN_NAME}"

fail() { echo "omp-ui-lite install: $*" >&2; exit 1; }

os="$(uname -s)"; arch="$(uname -m)"
[ "$os" = "Linux" ] || fail "v1 supports Linux only (detected $os). Build from source: npm ci && npm run bundle -w @omp-ui/host-lite && node packages/host-lite/dist/cli.js serve"
[ "$arch" = "x86_64" ] || fail "v1 ships linux-x64 only (detected $arch). Build from source as above."

if [ -n "${OMP_UI_LITE_VERSION:-}" ]; then
  version="$OMP_UI_LITE_VERSION"
else
  if [ "$CHANNEL" = "nightly" ]; then
    tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100" \
      | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | grep -- '-nightly' | head -1)" || true
  else
    tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v\{0,1\}[^"]*\)"$/\1/')" || true
  fi
  [ -n "${tag:-}" ] || fail "could not resolve the latest ${CHANNEL} release; pin OMP_UI_LITE_VERSION"
  version="${tag#v}"
fi

base="https://github.com/${REPO}/releases/download/v${version}"
echo "Installing omp-ui-lite ${version} (${os}-${arch})"
mkdir -p "${HOME}/.local/bin" "$LIB_DIR"
curl -fsSL "${base}/${BIN_NAME}-linux-x64" -o "${DEST_BIN}.tmp"
curl -fsSL "${base}/${BIN_NAME}-linux-x64.sha256" -o "${DEST_BIN}.tmp.sha256"
# Asset names must match what release-artifacts publishes for host-lite (integration step E);
# adjust both sides together if the naming changes.
[ "$(sha256sum "${DEST_BIN}.tmp" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "${DEST_BIN}.tmp.sha256")" ] \
  || fail "checksum mismatch for ${BIN_NAME}-linux-x64"
# node-pty stays ADJACENT, not embedded (SEA native-module constraint): the unit sets NODE_PATH.
curl -fsSL "${base}/host-lite-node-pty-linux-x64.tgz" -o "$LIB_DIR/node-pty.tgz" || fail "missing node-pty asset"
tar -xzf "$LIB_DIR/node-pty.tgz" -C "$LIB_DIR" && rm "$LIB_DIR/node-pty.tgz"
chmod 0755 "${DEST_BIN}.tmp" && mv "${DEST_BIN}.tmp" "$DEST_BIN" && rm "${DEST_BIN}.tmp.sha256"

cat <<EOF

Installed: ${DEST_BIN}
Next steps:
  1. ${DEST_BIN} status        # shows bind/port; serve first-run prints the join URL
  2. run in foreground now:    OMP_UI_LITE_HOME=~/.local/share/omp-ui-lite ${DEST_BIN} serve
  3. or install as a service:  copy packaging/omp-ui-lite.service to
     ~/.config/systemd/user/, then:
       loginctl enable-linger "\$(id -un)"   # survives logout (required on servers)
       systemctl --user daemon-reload && systemctl --user enable --now omp-ui-lite
  4. join it from an owner app: Settings → Remote instances → paste the printed URL.
EOF
