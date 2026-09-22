#!/usr/bin/env bash
# Asserts that the self-hosted runner this job landed on is a single-job
# (ephemeral) registration on a filesystem no earlier job wrote to, with no
# host credential or Docker socket reachable (issue #629). This detects a
# misconfigured pool; it is not a security boundary — a job that already owns
# the runner also owns this check.
set -uo pipefail

failed=0
fail() {
  printf '::error::%s\n' "$1" >&2
  failed=1
}

# The runner sets RUNNER_TEMP=<root>/_work/_temp under the default --work
# _work; <root>/.runner is the settings file config.sh writes. Its Ephemeral
# member serialises only when set (EmitDefaultValue = false).
temp="${RUNNER_TEMP:-}"
root="${temp%/_work/_temp}"
if [ -z "$temp" ] || [ "$root" = "$temp" ]; then
  fail "RUNNER_TEMP is '${temp:-<unset>}', expected <runner-root>/_work/_temp"
elif [ ! -f "$root/.runner" ]; then
  fail "no runner settings file at $root/.runner"
elif ! grep -Eiq '"ephemeral":[[:space:]]*true' "$root/.runner"; then
  fail "runner '${RUNNER_NAME:-?}' is not an ephemeral (single-job) registration"
fi

# The image's home holds only /etc/skel; these appear after a job has run
# npm ci / electron-builder. Must run before actions/setup-node restores ~/.npm.
for stale in "$HOME/.npm" "$HOME/.cache"; do
  if [ -e "$stale" ]; then
    fail "$stale exists before this job installed anything: the runner filesystem was reused"
  fi
done

[ -n "${ACCESS_TOKEN:-}" ] && fail "ACCESS_TOKEN is present in the job environment"
[ -n "${REG_TOKEN:-}" ] && fail "REG_TOKEN is present in the job environment"

# OMP_UI_RUNNER_DOCKER_SOCKET is a test seam so the check can run on a
# developer machine that has Docker.
sock="${OMP_UI_RUNNER_DOCKER_SOCKET:-/var/run/docker.sock}"
[ -S "$sock" ] && fail "a Docker socket is mounted at $sock"
[ -n "${DOCKER_HOST:-}" ] && fail "DOCKER_HOST is set in the job environment"

exit "$failed"
