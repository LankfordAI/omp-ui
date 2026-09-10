import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostUpdateState } from "@omp-ui/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_UPDATE_DEFERRAL_LIMIT,
  HOST_UPDATE_GRACE_MS,
  HostUpdater,
  hostUpdatePaths,
  readHostUpdateDisk,
  type HostRelease,
  type HostUpdatePaths,
  type HostUpdaterDeps,
} from "./host-update";

const RELEASE: HostRelease = {
  version: "1.1.0",
  url: "https://releases.example/omp-ui-host-1.1.0-linux-x64.tar.gz",
  sha512: "ABCDEF",
  size: 3,
};

interface Harness {
  deps: HostUpdaterDeps;
  clock: { t: number };
  calls: string[];
  sent: HostUpdateState[];
  crumbs: string[];
  /** Fires the earliest armed timer at its due time and settles the resulting handover. */
  fire(): Promise<void>;
  timers(): number;
}

function harness(root: string, over: Partial<HostUpdaterDeps> & { ack?: boolean; feed?: HostRelease | null } = {}): Harness {
  const clock = { t: 1_000_000 };
  const armed: { fn: () => void; due: number }[] = [];
  const calls: string[] = [];
  const sent: HostUpdateState[] = [];
  const crumbs: string[] = [];
  const ack = over.ack ?? true;
  const feed = over.feed === undefined ? RELEASE : over.feed;
  const deps: HostUpdaterDeps = {
    dataRoot: root,
    currentVersion: "1.0.0",
    fetchFeed: async () => feed,
    download: async (url, dest, onProgress) => {
      calls.push(`download ${path.basename(url)}`);
      onProgress(50);
      fs.writeFileSync(dest, "pkg");
      onProgress(100);
    },
    sha512File: async () => "abcdef",
    unpack: async (archive, dir) => {
      calls.push(`unpack ${path.basename(archive)} -> ${path.basename(dir)}`);
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(path.join(dir, "bin", "omp-ui"), "binary");
    },
    spawnStaged: (dir, opts) => {
      calls.push(`spawn ${path.basename(dir)} ${path.basename(opts.dataRoot)}`);
      return {
        pid: 4242,
        waitForAck: async (timeoutMs) => {
          calls.push(`ack? ${timeoutMs}`);
          return ack;
        },
        kill: () => void calls.push("kill"),
      };
    },
    releaseAuthority: () => void calls.push("release"),
    reclaimAuthority: async () => void calls.push("reclaim"),
    hibernateAll: async () => {
      calls.push("hibernate");
      return ["tab-a", "tab-b"];
    },
    drainListeners: async () => void calls.push("drain"),
    clientCount: () => 0,
    liveSessionCount: () => 0,
    send: (state) => void sent.push(state),
    breadcrumbs: { record: (kind, fields) => void crumbs.push(`${kind} ${fields?.detail ?? ""}`), entries: () => [] },
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const timer = { fn, due: clock.t + ms };
      armed.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = armed.indexOf(handle as { fn: () => void; due: number });
      if (index >= 0) armed.splice(index, 1);
    },
    ...over,
  };
  return {
    deps,
    clock,
    calls,
    sent,
    crumbs,
    async fire() {
      const timer = armed.shift();
      if (!timer) throw new Error("no timer armed");
      clock.t = Math.max(clock.t, timer.due);
      timer.fn();
      await vi.waitFor(() => expect(sent.at(-1)?.status).not.toBe("applying"));
    },
    timers: () => armed.length,
  };
}

/** Pretends `version` was installed via this machinery: its dir exists and `current` names it. */
function seedInstalled(root: string, version: string): void {
  const paths = hostUpdatePaths(root);
  fs.mkdirSync(path.join(paths.versionDir(version), "bin"), { recursive: true });
  fs.writeFileSync(path.join(paths.versionDir(version), "bin", "omp-ui"), version);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.current, `${version}\n`);
  fs.writeFileSync(paths.staged, `${version}\n`);
}

describe("HostUpdater", () => {
  let root: string;
  let paths: HostUpdatePaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-update-"));
    paths = hostUpdatePaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts idle with the production deferral limit and nothing on disk", () => {
    const h = harness(root);
    const updater = new HostUpdater(h.deps);
    expect(updater.state).toMatchObject({
      currentVersion: "1.0.0",
      status: "idle",
      stagedVersion: null,
      rollbackVersion: null,
      lastAttempt: null,
      currentIsStaged: false,
      deferralLimit: HOST_UPDATE_DEFERRAL_LIMIT,
    });
    expect(h.sent).toEqual([]);
  });

  it("check: no feed or an older/equal version leaves idle; a newer one is available; a throwing feed is an error", async () => {
    const none = new HostUpdater(harness(root, { feed: null }).deps);
    expect((await none.check()).status).toBe("idle");
    expect(none.state.latestVersion).toBeNull();

    const same = new HostUpdater(harness(root, { feed: { ...RELEASE, version: "1.0.0" } }).deps);
    expect(await same.check()).toMatchObject({ status: "idle", latestVersion: "1.0.0" });
    await expect(same.download()).rejects.toThrow("no host update available");

    const h = harness(root);
    const newer = new HostUpdater(h.deps);
    expect(await newer.check()).toMatchObject({ status: "available", latestVersion: "1.1.0" });
    expect(h.sent.map((s) => s.status)).toEqual(["checking", "available"]);
    expect(h.crumbs).toEqual(["update-stage host:checking", "update-stage host:available 1.1.0"]);

    const failing = new HostUpdater(
      harness(root, {
        fetchFeed: async () => {
          throw new Error("feed offline");
        },
      }).deps,
    );
    expect(await failing.check()).toMatchObject({ status: "error", error: "feed offline" });

    const malformed = new HostUpdater(harness(root, { feed: { ...RELEASE, version: "1.2.3/../../escape" } }).deps);
    expect(await malformed.check()).toMatchObject({ status: "error", error: 'malformed feed version "1.2.3/../../escape"' });
    expect(fs.existsSync(paths.dir)).toBe(false);
  });

  it("download: a sha512 mismatch removes the archive, stages nothing, and reports error", async () => {
    const h = harness(root, { sha512File: async () => "deadbeef" });
    const updater = new HostUpdater(h.deps);
    await updater.check();
    await updater.download();
    expect(updater.state).toMatchObject({ status: "error", stagedVersion: null, progress: null });
    expect(updater.state.error).toContain("checksum mismatch for host 1.1.0");
    expect(fs.existsSync(paths.archive("1.1.0"))).toBe(false);
    expect(fs.existsSync(paths.versionDir("1.1.0"))).toBe(false);
    expect(h.calls).toEqual(["download omp-ui-host-1.1.0-linux-x64.tar.gz"]);
  });

  it("download → staged → immediate apply when no client and no live session", async () => {
    const h = harness(root);
    const updater = new HostUpdater(h.deps);
    await updater.check();
    await updater.download();

    expect(h.calls).toEqual([
      "download omp-ui-host-1.1.0-linux-x64.tar.gz",
      "unpack host-1.1.0.download -> host-1.1.0",
      "hibernate",
      "drain",
      "release",
      `spawn host-1.1.0 ${path.basename(root)}`,
      "ack? 60000",
    ]);
    expect(h.sent.map((s) => s.status)).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloading",
      "staged",
      "applying",
      "applying",
      "idle",
    ]);
    expect(h.sent.filter((s) => s.status === "downloading").map((s) => s.progress)).toEqual([0, 50, 100]);
    expect(updater.state).toMatchObject({
      status: "idle",
      stagedVersion: "1.1.0",
      currentIsStaged: true,
      affectedTabIds: ["tab-a", "tab-b"],
      rollbackVersion: null,
      lastAttempt: { fromVersion: "1.0.0", toVersion: "1.1.0", outcome: "applied", atMs: h.clock.t },
    });
    expect(fs.readFileSync(paths.current, "utf8")).toBe("1.1.0\n");
    expect(fs.readFileSync(paths.staged, "utf8")).toBe("1.1.0\n");
    expect(fs.existsSync(paths.archive("1.1.0"))).toBe(false);
    expect(fs.existsSync(paths.previous)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.lastAttempt, "utf8"))).toEqual(updater.state.lastAttempt);
    await expect(updater.apply()).rejects.toThrow("no staged host version to apply");
  });

  it("staged with clients arms one countdown; deferrals push it up to the limit; the timer applies", async () => {
    const h = harness(root, { clientCount: () => 2 });
    const updater = new HostUpdater(h.deps);
    const t0 = h.clock.t;
    await updater.check();
    await updater.download();
    expect(updater.state).toMatchObject({ status: "countdown", graceDeadlineMs: t0 + HOST_UPDATE_GRACE_MS, deferrals: 0 });
    expect(h.timers()).toBe(1);

    for (let n = 1; n <= HOST_UPDATE_DEFERRAL_LIMIT; n += 1) {
      h.clock.t += 30_000;
      expect(updater.defer()).toMatchObject({ deferrals: n, graceDeadlineMs: t0 + (n + 1) * HOST_UPDATE_GRACE_MS });
    }
    const exhausted = updater.defer();
    expect(exhausted).toMatchObject({ deferrals: 3, graceDeadlineMs: t0 + 4 * HOST_UPDATE_GRACE_MS });
    expect(h.timers()).toBe(1);
    expect(h.crumbs.filter((c) => c.includes("deferred"))).toEqual([
      "update-stage host:countdown deferred 1",
      "update-stage host:countdown deferred 2",
      "update-stage host:countdown deferred 3",
    ]);
    // A periodic check never disturbs an armed countdown.
    expect((await updater.check()).status).toBe("countdown");

    await h.fire();
    expect(h.clock.t).toBe(t0 + 4 * HOST_UPDATE_GRACE_MS);
    expect(updater.state).toMatchObject({ status: "idle", currentIsStaged: true, graceDeadlineMs: null });
    expect(h.calls.slice(-5)).toEqual(["hibernate", "drain", "release", `spawn host-1.1.0 ${path.basename(root)}`, "ack? 60000"]);
    expect(h.timers()).toBe(0);
  });

  it("no deferral moves the deadline past firstCountdownAt + ceiling", async () => {
    const h = harness(root, {
      liveSessionCount: () => 1,
      limits: { graceMs: 120_000, deferralLimit: 3, ceilingMs: 300_000 },
    });
    const updater = new HostUpdater(h.deps);
    const t0 = h.clock.t;
    await updater.check();
    await updater.download();
    expect(updater.defer().graceDeadlineMs).toBe(t0 + 240_000);
    expect(updater.defer()).toMatchObject({ graceDeadlineMs: t0 + 300_000, deferrals: 2 });
    expect(updater.defer()).toMatchObject({ graceDeadlineMs: t0 + 300_000, deferrals: 2 });
    expect(h.timers()).toBe(1);
  });

  it("apply now during a countdown cancels the timer and hands over", async () => {
    const h = harness(root, { clientCount: () => 1 });
    const updater = new HostUpdater(h.deps);
    await updater.check();
    await updater.download();
    expect(h.timers()).toBe(1);
    await updater.apply();
    expect(h.timers()).toBe(0);
    expect(updater.state).toMatchObject({ status: "idle", currentIsStaged: true });
  });

  it("a successful ack rotates pointers and keeps exactly one previous version", async () => {
    seedInstalled(root, "1.0.0");
    fs.mkdirSync(paths.versionDir("0.9.0"), { recursive: true });
    fs.mkdirSync(paths.versionDir("0.8.0"), { recursive: true });
    const h = harness(root);
    const updater = new HostUpdater(h.deps);
    expect(updater.state).toMatchObject({ status: "idle", stagedVersion: "1.0.0", currentIsStaged: true });
    await updater.check();
    await updater.download();

    expect(fs.readFileSync(paths.current, "utf8")).toBe("1.1.0\n");
    expect(fs.readlinkSync(paths.previous)).toMatch(/host-1\.0\.0$/);
    expect(fs.readFileSync(path.join(paths.previous, "bin", "omp-ui"), "utf8")).toBe("1.0.0");
    expect(fs.readdirSync(paths.dir).sort()).toEqual(["current", "host-1.0.0", "host-1.1.0", "host-previous", "last-attempt.json", "staged"]);
    expect(updater.state).toMatchObject({ rollbackVersion: "1.0.0", currentIsStaged: true, status: "idle" });
    expect(readHostUpdateDisk(root)).toEqual({
      current: "1.1.0",
      staged: "1.1.0",
      previous: "1.0.0",
      lastAttempt: { fromVersion: "1.0.0", toVersion: "1.1.0", outcome: "applied", atMs: h.clock.t },
    });
  });

  it("an ack timeout kills the replacement, reclaims authority, records a failed attempt, and keeps pointers", async () => {
    seedInstalled(root, "1.0.0");
    const h = harness(root, { ack: false });
    const updater = new HostUpdater(h.deps);
    await updater.check();
    await updater.download();

    expect(h.calls.slice(-4)).toEqual([`spawn host-1.1.0 ${path.basename(root)}`, "ack? 60000", "kill", "reclaim"]);
    expect(updater.state).toMatchObject({
      status: "error",
      stagedVersion: "1.1.0",
      currentIsStaged: false,
      rollbackVersion: null,
      lastAttempt: { fromVersion: "1.0.0", toVersion: "1.1.0", outcome: "failed", atMs: h.clock.t },
    });
    expect(updater.state.error).toContain("did not acknowledge within 60 s");
    expect(fs.readFileSync(paths.current, "utf8")).toBe("1.0.0\n");
    expect(fs.existsSync(paths.previous)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.lastAttempt, "utf8")).outcome).toBe("failed");
    expect(h.crumbs.at(-1)).toMatch(/^update-stage host:error host 1\.1\.0 did not acknowledge/);
    // The staged version stays applicable for a manual retry.
    expect(fs.existsSync(paths.versionDir("1.1.0"))).toBe(true);
  });

  it("a failing spawn reclaims authority and reports the error", async () => {
    const h = harness(root, {
      spawnStaged: () => {
        throw new Error("ENOENT bin/omp-ui");
      },
    });
    const updater = new HostUpdater(h.deps);
    await updater.check();
    await updater.download();
    expect(h.calls.slice(-3)).toEqual(["drain", "release", "reclaim"]);
    expect(updater.state).toMatchObject({ status: "error", error: "ENOENT bin/omp-ui" });
    expect(updater.state.lastAttempt?.outcome).toBe("failed");
  });

  it("the new process boots currentIsStaged with a rollback target; rollback reverses the handover", async () => {
    seedInstalled(root, "1.0.0");
    const old = new HostUpdater(harness(root).deps);
    await old.check();
    await old.download();

    const h = harness(root, { currentVersion: "1.1.0" });
    const fresh = new HostUpdater(h.deps);
    expect(fresh.state).toMatchObject({
      currentVersion: "1.1.0",
      status: "idle",
      stagedVersion: "1.1.0",
      currentIsStaged: true,
      rollbackVersion: "1.0.0",
      lastAttempt: { fromVersion: "1.0.0", toVersion: "1.1.0", outcome: "applied" },
    });
    await expect(fresh.apply()).rejects.toThrow("no staged host version to apply");

    await fresh.rollback();
    expect(h.calls).toEqual(["hibernate", "drain", "release", `spawn host-1.0.0 ${path.basename(root)}`, "ack? 60000"]);
    expect(fresh.state).toMatchObject({
      status: "idle",
      currentIsStaged: true,
      rollbackVersion: "1.1.0",
      lastAttempt: { fromVersion: "1.1.0", toVersion: "1.0.0", outcome: "rolled-back" },
    });
    expect(fs.readFileSync(paths.current, "utf8")).toBe("1.0.0\n");
    expect(fs.readlinkSync(paths.previous)).toMatch(/host-1\.1\.0$/);
    expect(h.crumbs.at(-1)).toBe("update-stage host:idle rolled-back 1.0.0");

    await expect(new HostUpdater(harness(root, { currentVersion: "1.0.0" }).deps).rollback()).resolves.toBeUndefined();
  });

  it("rollback without a retained previous version is refused", async () => {
    const updater = new HostUpdater(harness(root).deps);
    await expect(updater.rollback()).rejects.toThrow("no previous host version to roll back to");
  });

  it("a version staged by an earlier process life is offered again and resumes on the next check", async () => {
    const first = harness(root, { clientCount: () => 1 });
    const staged = new HostUpdater(first.deps);
    await staged.check();
    await staged.download();
    expect(staged.state.status).toBe("countdown");
    staged.dispose();
    expect(first.timers()).toBe(0);

    const h = harness(root);
    const resumed = new HostUpdater(h.deps);
    expect(resumed.state).toMatchObject({ status: "staged", stagedVersion: "1.1.0", currentIsStaged: false });
    expect(await resumed.check()).toMatchObject({ status: "idle", currentIsStaged: true });
    expect(h.calls).toEqual(["hibernate", "drain", "release", `spawn host-1.1.0 ${path.basename(root)}`, "ack? 60000"]);
  });

  it("a staged pointer whose dir is gone is not offered", async () => {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.staged, "1.1.0\n");
    const updater = new HostUpdater(harness(root, { feed: null }).deps);
    expect(updater.state).toMatchObject({ status: "idle", stagedVersion: null });
  });

  it("dispose stops publication", async () => {
    const h = harness(root, { feed: null });
    const updater = new HostUpdater(h.deps);
    updater.dispose();
    await updater.check();
    expect(h.sent).toEqual([]);
  });
});
