import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  APP_GITHUB_REPO,
  dataHome,
  defaultFetch,
  downloadFileAtomically,
  readHostRecord,
  type FetchLike,
} from "@omp-ui/core";
import { connectInstanceClient, HOST_PROTOCOL } from "@omp-ui/server";
import type { HostRelease, StagedHostChild } from "./host-update";

/**
 * The production half of {@link HostUpdaterDeps} the boot sequence wires in
 * (issue #442 §10.2): the release feed, the verified archive path, the staged
 * replacement, and the installed layout's `current` pointer (§10.1). Every
 * function here is pure composition over core helpers and the OS; the state
 * machine itself lives in `host-update.ts` and is tested with fakes.
 */

/** Feeds and archives are published under the repository's latest release. */
export const HOST_RELEASE_BASE = `https://github.com/${APP_GITHUB_REPO}/releases/latest/download`;

const FEED_TIMEOUT_MS = 10_000;
/** How often the arbiter re-reads `host.json` while waiting for the replacement's ack. */
const ACK_POLL_MS = 500;
/** Authenticated probe budget per ack attempt. */
const ACK_PROBE_TIMEOUT_MS = 2000;
/** A replacement that ignored SIGTERM this long is killed outright. */
const KILL_GRACE_MS = 3000;

const execFileAsync = promisify(execFile);

/** `latest-host-<platform>.yml`; null on a platform with no host lane. */
export function hostFeedName(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "linux":
      return "latest-host-linux.yml";
    case "darwin":
      return "latest-host-mac.yml";
    case "win32":
      return "latest-host-win.yml";
    default:
      return null;
  }
}

/** The archive suffix the release pipeline gives this platform/arch's lane. */
function laneSuffix(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "linux":
      return `-linux-${arch}.tar.gz`;
    case "darwin":
      return `-mac-${arch}.zip`;
    case "win32":
      return `-win-${arch}.zip`;
    default:
      return null;
  }
}

/** Lower-case hex; the feed publishes base64 (electron-updater style) but the updater compares hex digests. */
export function normalizeSha512(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return trimmed.toLowerCase();
  if (!/^[A-Za-z0-9+/]{86}={0,2}$/.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, "base64");
  return bytes.length === 64 ? bytes.toString("hex") : null;
}

interface FeedFile {
  url: string;
  sha512: string;
  size: number;
  arch: string | null;
}

/**
 * Parses the release pipeline's `latest-host-<platform>.yml` — the
 * electron-updater layout: top-level `version`, `path`, `sha512`,
 * `releaseDate`, and a `files:` list of `{url, sha512, size, arch}` — and
 * selects this platform/arch's archive. A minimal line reader: the feed is
 * generated, flat, and quoted only for the ISO date. Null when nothing in it
 * names this lane.
 */
export function parseHostFeed(text: string, platform: NodeJS.Platform, arch: string): HostRelease | null {
  const suffix = laneSuffix(platform, arch);
  if (suffix === null) return null;
  let version: string | null = null;
  let topPath: string | null = null;
  let topSha: string | null = null;
  const files: FeedFile[] = [];
  let current: Partial<FeedFile> | null = null;
  let inFiles = false;
  const scalar = (raw: string): string => raw.trim().replace(/^['"]|['"]$/g, "");
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      if (current !== null) files.push(current as FeedFile);
      current = null;
      inFiles = false;
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (m === null) continue;
      const [, key, raw] = m;
      if (key === "files") inFiles = true;
      else if (key === "version") version = scalar(raw!);
      else if (key === "path") topPath = scalar(raw!);
      else if (key === "sha512") topSha = scalar(raw!);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    const field = item ?? /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field === null) continue;
    if (item !== null) {
      if (current !== null) files.push(current as FeedFile);
      current = { arch: null };
    }
    if (current === null) continue;
    const [, key, raw] = field;
    const value = scalar(raw!);
    if (key === "url") current.url = value;
    else if (key === "sha512") current.sha512 = value;
    else if (key === "size") current.size = Number(value);
    else if (key === "arch") current.arch = value;
  }
  if (current !== null) files.push(current as FeedFile);
  if (version === null) return null;
  // The lane suffix is the selector: it names platform AND arch, so a feed for
  // another platform can never be adopted through a matching `arch` key.
  const candidates = files.filter((f) => typeof f.url === "string" && typeof f.sha512 === "string");
  const match =
    candidates.find((f) => f.url.endsWith(suffix)) ??
    (topPath !== null && topSha !== null && topPath.endsWith(suffix)
      ? { url: topPath, sha512: topSha, size: 0, arch }
      : undefined);
  if (match === undefined) return null;
  const sha512 = normalizeSha512(match.sha512);
  if (sha512 === null) return null;
  return {
    version,
    url: `${HOST_RELEASE_BASE}/${match.url}`,
    sha512,
    size: Number.isFinite(match.size) ? match.size : 0,
  };
}

/** Fetches and parses this platform's feed; rejects on HTTP failure so `check()` reports the error. */
export async function fetchHostFeed(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fetchImpl: FetchLike = defaultFetch,
): Promise<HostRelease | null> {
  const name = hostFeedName(platform);
  if (name === null) return null;
  const response = await fetchImpl(`${HOST_RELEASE_BASE}/${name}`, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`host feed ${name}: HTTP ${response.status}`);
  return parseHostFeed(Buffer.from(await response.arrayBuffer()).toString("utf8"), platform, arch);
}

/** Streams the archive to `dest` (tmp + rename inside core); progress is 0–100 or skipped when indeterminate. */
export function downloadHostArchive(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  return downloadFileAtomically({
    url,
    targetPath: dest,
    description: "host update",
    onProgress: (pct) => {
      if (pct !== null) onProgress(pct);
    },
  });
}

/** Lower-case hex SHA-512 of a file, streamed. */
export function sha512File(file: string): Promise<string> {
  // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Unpacks the release archive into `dir`. `tar` reads both formats — GNU tar
 * the tarball, bsdtar (macOS, Windows 10+) the zip too — as the packager and
 * its smoke test already rely on; the archive's single top-level `<version>/`
 * directory is stripped so `dir/bin/omp-ui` is the layout the updater runs.
 * On Windows bsdtar is named by path: a Git for Windows install can put GNU
 * tar, which cannot read a zip, ahead of System32 on PATH (issue #470).
 */
export async function unpackHostArchive(archive: string, dir: string): Promise<void> {
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  await execFileAsync(tar, ["-xf", archive, "-C", dir, "--strip-components=1"], { windowsHide: true });
  const bin = path.join(dir, "bin", process.platform === "win32" ? "omp-ui.exe" : "omp-ui");
  if (!fs.existsSync(bin)) throw new Error(`${path.basename(archive)} has no bin/${path.basename(bin)}`);
}

export interface SpawnStagedDeps {
  platform?: NodeJS.Platform;
  /** This build's version, sent as the probe's `clientVersion`. */
  hostVersion: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Launches `<versionDir>/bin/omp-ui serve` against the same data root,
 * detached, with stdout/stderr inherited so its boot lands in the same journal
 * or log file as ours. Acknowledgement is observed, never reported: the
 * replacement has written its own `host.json` (its pid, not ours) and answers
 * an authenticated `host:status` — which its boot sequence only reaches after
 * the claim, the registry load, and the local listener (issue #442 §10.2).
 */
export function spawnStagedHost(versionDir: string, opts: { dataRoot: string }, deps: SpawnStagedDeps): StagedHostChild {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const bin = path.join(versionDir, "bin", platform === "win32" ? "omp-ui.exe" : "omp-ui");
  const child: ChildProcess = spawn(bin, ["serve"], {
    cwd: versionDir,
    env: { ...(deps.env ?? process.env), OMP_UI_DATA_DIR: opts.dataRoot },
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });
  child.unref();
  const pid = child.pid ?? -1;

  const probe = async (): Promise<boolean> => {
    const record = readHostRecord(opts.dataRoot);
    if (record === null || record.pid !== pid) return false;
    try {
      const client = await connectInstanceClient(record.endpoint, record.controlCredential, {
        timeoutMs: ACK_PROBE_TIMEOUT_MS,
        hello: {
          clientRole: "browser",
          clientKind: "browser",
          clientVersion: deps.hostVersion,
          clientProtocol: HOST_PROTOCOL,
        },
      });
      try {
        await client.request("host:status", []);
        return true;
      } finally {
        client.close();
      }
    } catch {
      return false;
    }
  };

  return {
    pid,
    async waitForAck(timeoutMs) {
      const deadline = now() + timeoutMs;
      while (!exited && now() < deadline) {
        if (await probe()) return true;
        await sleep(ACK_POLL_MS);
      }
      return false;
    },
    kill() {
      if (exited) return;
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      force.unref();
    },
  };
}

export interface SwitchCurrentDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The data root whose `updates/` dir stages versions; a pointer into it is ours. */
  dataRoot: string;
}

/**
 * Re-points the installed layout at `versionDir` (issue #442 §10.1): on
 * Linux/macOS `<dataHome>/omp-ui-host/current` (the stable `~/.local/bin/omp-ui`
 * resolves through it, so it needs no change); on Windows the
 * `%LOCALAPPDATA%\omp-ui-host\bin` junction to the active `bin`. Only a
 * pointer that is absent or already ours — a link into `omp-ui-host/versions/`
 * or `<dataRoot>/updates/` — is replaced; anything else is refused so an
 * installer-owned or user-made path is never clobbered.
 */
export function switchCurrent(versionDir: string, deps: SwitchCurrentDeps): void {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const layout = path.join(dataHome(platform, env, deps.home), "omp-ui-host");
  const ours = (target: string): boolean => {
    const resolved = path.resolve(target);
    const within = (parent: string): boolean => resolved === parent || resolved.startsWith(parent + path.sep);
    return within(path.join(layout, "versions")) || within(path.join(deps.dataRoot, "updates"));
  };
  const pointer = platform === "win32" ? path.join(layout, "bin") : path.join(layout, "current");
  const target = platform === "win32" ? path.join(versionDir, "bin") : versionDir;
  if (!fs.existsSync(target)) throw new Error(`${target} does not exist`);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(pointer);
  } catch {
    // Absent: ours to create.
  }
  if (existing !== null) {
    if (!existing.isSymbolicLink()) throw new Error(`${pointer} is not a link; refusing to replace it`);
    const linked = path.resolve(path.dirname(pointer), fs.readlinkSync(pointer));
    if (!ours(linked)) throw new Error(`${pointer} points at ${linked}, which is not ours; refusing to replace it`);
  }
  fs.mkdirSync(layout, { recursive: true });
  if (platform === "win32") {
    // A junction cannot be renamed over; remove-then-create is the bounded window Windows allows.
    fs.rmSync(pointer, { force: true });
    fs.symlinkSync(target, pointer, "junction");
    return;
  }
  const tmp = `${pointer}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, pointer);
}
