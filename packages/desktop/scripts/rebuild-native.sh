#!/usr/bin/env bash
# Rebuild native modules for Electron with release-lane resilience (issue #426).
#
# node-gyp fetches the Electron headers with a 10 s connect timeout and does not
# retry a connect timeout, and the default dist origin, www.electronjs.org/headers,
# is only a 302 redirector in front of Electron's artifacts CDN — one slow
# handshake to that redirector used to kill a release lane outright. Point the
# download at the CDN origin, retry network-stage failures, and label the final
# error as a headers download (transient) or a compile failure (real defect).
#
# All arguments forward to the workspace rebuild script unchanged:
#   bash packages/desktop/scripts/rebuild-native.sh --arch=x64
set -o pipefail

attempts=3
sleep_seconds=15

# electron-rebuild uses argv['dist-url'] || process.env.ELECTRON_REBUILD_DIST_URL
# (@electron/rebuild lib/cli.js) and node-gyp appends /v<version>/ to it, so the
# value must end at /headers/dist with no trailing slash. Override it in a
# workflow env block if the CDN layout ever changes.
export ELECTRON_REBUILD_DIST_URL="${ELECTRON_REBUILD_DIST_URL:-https://artifacts.electronjs.org/headers/dist}"

# Signatures node-gyp leaves in the log when a dist file (headers tarball,
# SHASUMS, win import lib) failed to fetch: undici connect errors, non-200
# downloads, checksum mismatch, install rollback, its ENOTFOUND rewrite.
network_re='UND_ERR_|Connect Timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network connectivity|response downloading|status code downloading|not match remote|rolling back install|downloading/extracting the tarball'

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

status=0
for attempt in $(seq 1 "$attempts"); do
  echo "::group::electron-rebuild attempt ${attempt}/${attempts} (headers dist: ${ELECTRON_REBUILD_DIST_URL})"
  npm run rebuild:native --workspace @omp-ui/desktop -- "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  echo "::endgroup::"
  if (( status == 0 )); then
    exit 0
  fi
  if ! grep -qE "$network_re" "$log"; then
    # Failed in the compile stage - deterministic; retrying wastes minutes.
    break
  fi
  if (( attempt < attempts )); then
    echo "::warning::rebuild attempt ${attempt} failed fetching Electron headers (exit ${status}); retrying in ${sleep_seconds}s"
    sleep "$sleep_seconds"
  fi
done

if grep -qE "$network_re" "$log"; then
  echo "::error::node-pty rebuild failed downloading Electron headers from ${ELECTRON_REBUILD_DIST_URL} - network/transient lane failure, not a code defect; rerun the failed job"
else
  echo "::error::node-pty rebuild failed in the compile stage - treat as a real defect; see the build output above"
fi
exit "$status"
