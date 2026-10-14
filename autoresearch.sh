#!/usr/bin/env bash
# Canonical benchmark entrypoint: median wall time for a new rpc-ui session
# to boot through the real SessionManager spawn path and settle its
# initialCommands rail. See bench/startup-bench.ts for the determinism notes.
set -euo pipefail
cd "$(dirname "$0")"
node_modules/.bin/esbuild --bundle bench/startup-bench.ts \
  --platform=node --format=cjs \
  --external:node-pty --external:@parcel/watcher \
  --outfile=bench/.startup-bench.cjs --log-level=warning
exec node bench/.startup-bench.cjs
