# Deploying `@omp-ui/host-lite` in Docker

Run the official `ghcr.io/lankfordai/omp-ui-lite` container image (`linux/amd64`, plain Node 22, non-root `uid 1000`) as a headless fleet member and Routines host.

## Quick start

1. Copy [`compose.yaml`](compose.yaml) onto the host and start the service:

```bash
docker compose -f packages/host-lite/docker/compose.yaml up -d
```

2. Wait for the healthcheck (`omp-ui-lite status`) to report `healthy`, then read the minted join token explicitly:

```bash
docker compose -f packages/host-lite/docker/compose.yaml exec omp-ui-lite omp-ui-lite token
```

`omp-ui-lite serve` never prints the join token into container logs, and `omp-ui-lite status` checks local health (`state:get`) without printing credentials. Pass `--url` to `omp-ui-lite token` for a template link, or assemble the host's reachable LAN/Tailscale URL directly:

```text
http://<host-ip-or-dns>:4677/?t=<token>
```

3. Join it from a desktop app under **Settings → Remote instances**.

## Provider credentials and machine key

### Provider keys (env-first)

In containers, pass provider API keys via container environment variables (such as `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) in your Compose secret/env setup. Rotate keys by updating the environment/secret source and restarting the container.

Note that environment variables on PID 1 are readable via `/proc/1/environ` and `docker exec` by anyone with access to the container or Docker daemon.

### Sealing key (`OMP_UI_LITE_KEY_FILE`)

If you also use **Roll out keys** from a joined desktop owner to store sealed keys in `/data/provider-keys.json`, Host Lite seals them with a 32-byte key:

- Default: auto-generated `/data/machine.key` (`0600`) inside the persistent volume.
- External key mount: set `OMP_UI_LITE_KEY_FILE=/run/secrets/omp-ui-lite.key` and mount a 32-byte raw key file read-only.

Local Docker Compose bind mounts preserve the host file's UID and mode verbatim (they do not rewrite `uid`/`mode`), and Host Lite rejects key files readable by group or other (`mode & 0o077`). Create the host file owned by `uid 1000` (`node`) with mode `0400` or `0600` before starting Compose:

```bash
head -c 32 /dev/urandom | sudo install -o 1000 -g 1000 -m 0400 /dev/stdin machine.key
```

> **Warning:** Back up your sealing key. If `machine.key` or the `OMP_UI_LITE_KEY_FILE` target is lost, sealed entries in `/data/provider-keys.json` become permanently unreadable and must be rolled out again.

### Optional read-only `models.yml`

To mount a custom OMP model catalog without breaking OMP's native addon directory, mount only the file read-only:

```yaml
- ./models.yml:/home/node/.omp/agent/models.yml:ro
```

The image pre-creates `/home/node/.omp`, `/home/node/.omp/natives`, and `/home/node/.omp/agent` owned by `node:node` (`1000:1000`) so bind-mounting `models.yml` leaves `/home/node/.omp/natives` writable.

## Persistent volume and single-writer contract

`/data` (`OMP_UI_LITE_HOME=/data`) holds:

- `registry.json` (projects, sessions, remote settings, fleet grants)
- `routines.json` and `routine-runs.json`
- session lineages (`sessions/`, `archive/`, `chats/`), worktrees (`worktrees/`), and audit logs (`logs/`)
- `lite.flock` + `lite.lock` (single-writer lock) and `control.sock`

**Single writer only:** never attach the same `/data` volume to two running `omp-ui-lite` containers. On Linux, Host Lite holds a kernel `flock(2)` on `/data/lite.flock` for the process lifetime:

- A second container pointed at the same volume exits immediately with a lock error, even across isolated PID namespaces or matching hostnames.
- After an ungraceful `docker kill` (`SIGKILL`), the kernel releases `/data/lite.flock` atomically so the restarted container recovers cleanly without manual lock deletion.

## Appliance and sandbox boundaries

- **No host SSH agent or OS keychain:** SSH keys, git credentials, and host keychains are not forwarded into the container.
- **Explicit projects window:** Only directories bind-mounted into the container (for example `./projects:/projects`) are visible. Every registered project path must exist at that path inside the container.
- **Explicit port publishing:** Docker's bridge network does not pass LAN discovery broadcasts. Publish `4677:4677` explicitly (or bind to a specific interface such as `127.0.0.1:4677:4677` or a Tailscale IP).
- **Docker CLI without daemon socket:** The static `docker` CLI binary is included for workflows that target an explicit remote Docker host (`DOCKER_HOST`). No `/var/run/docker.sock` is mounted by default; mounting the host Docker socket grants root-equivalent control over the host and is opt-in only.
- **Included runtime tools:** `omp` (pinned at `/opt/omp-ui-lite/omp/bin/omp` with `manager.json`), `git`, `gh`, `uv`/`uvx`, `bun`/`bunx`, `python3`, `jq`, `ripgrep`, `sqlite3`, `build-essential`, `ffmpeg`, `imagemagick`, `openssh-client`, `tini`, `util-linux` (`flock`), and `tzdata`.

## Routines, timezone, and hostname

- Set `hostname:` in `compose.yaml` to a human-readable label; it appears as the Fleet machine label and the Routines `machineLabel`.
- Set `TZ` (for example `TZ: America/New_York`) so cron schedules and logs match your timezone (`tzdata` is baked in).
- Routines start **disabled** by default. Opt in either by setting `OMP_UI_LITE_ROUTINES: "1"` in `compose.yaml` or by running:

```bash
docker compose -f packages/host-lite/docker/compose.yaml exec omp-ui-lite omp-ui-lite routines enable
```

## Updating (redeploy-only)

The container image is immutable (`OMP_UI_LITE_CONTAINER=1`, `packageFormat: "container"`):

- In a joined desktop app's **Fleet** view, containerized members show a `container` chip, disable **Update versions…**, and are skipped by **Update all**.
- `omp` is baked into the image at `/opt/omp-ui-lite/omp/bin/omp` with `/opt/omp-ui-lite/omp/manager.json` and `OMP_UI_OMP_PATH`, so neither `omp` nor `omp-ui-lite` attempts in-place self-updates.
- Update by pulling a newer image tag and recreating the container against the same `/data` volume:

```bash
docker compose -f packages/host-lite/docker/compose.yaml pull
docker compose -f packages/host-lite/docker/compose.yaml up -d
```

## Building locally

Build from the repository root:

```bash
docker build -f packages/host-lite/Dockerfile \
  --build-arg HOST_LITE_VERSION=0.0.0-local \
  -t omp-ui-lite:local .
```

Run the end-to-end container smoke suite:

```bash
node packages/host-lite/scripts/smoke-container.mjs omp-ui-lite:local 0.0.0-local
```
