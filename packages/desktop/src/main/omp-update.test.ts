import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DownloadFetchLike, FetchLike, OmpUpdateState } from "@omp-ui/core";
import { OmpUpdater, type OmpUpdaterDeps } from "./omp-update";

// No vi.mock("electron") here: omp-update.ts imports only @omp-ui/core and
// Node — that absence is the structural proof the dialogs are gone (issue #19).

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-omp-updater-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sent: { channel: string; state: OmpUpdateState }[] = [];
const statuses = (): OmpUpdateState["status"][] => sent.map((s) => s.state.status);

/** npm registry latest-version JSON double. */
function registryFetch(body: unknown): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

/** Multi-chunk streaming binary double carrying a content-length. */
function streamFetch(chunks: Buffer[]): DownloadFetchLike {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-length" ? String(total) : null) },
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
        };
      },
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

interface MadeUpdater {
  updater: OmpUpdater;
  dismissed: { value: string | null };
  onApplied: Mock<(version: string) => void>;
}

function makeUpdater(overrides: Partial<OmpUpdaterDeps> = {}): MadeUpdater {
  const dismissed = { value: null as string | null };
  const onApplied = vi.fn<(version: string) => void>();
  const updater = new OmpUpdater({
    getDismissed: () => dismissed.value,
    setDismissed: (v) => {
      dismissed.value = v;
    },
    onApplied,
    send: (channel, state) => sent.push({ channel, state: { ...state } }),
    channel: "omp:updateState",
    installPath: "/managed/omp",
    fetchImpl: registryFetch({ version: "1.2.0" }),
    runner: async () => "omp/1.0.0",
    ...overrides,
  });
  return { updater, dismissed, onApplied };
}

beforeEach(() => {
  sent.length = 0;
});

describe("OmpUpdater.checkNow", () => {
  it("stays silent in the background when the registry is unreachable", async () => {
    const { updater } = makeUpdater({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("idle");
    expect(statuses()).toEqual(["checking", "idle"]);
  });

  it("answers a manual check with the error when the registry is unreachable", async () => {
    const { updater } = makeUpdater({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await updater.checkNow(true);
    expect(updater.state.status).toBe("error");
    expect(updater.state.error).toBe("could not reach the omp release registry");
  });

  it("announces an available update with versions and install path", async () => {
    const { updater } = makeUpdater();
    await updater.checkNow(false);
    expect(updater.state.status).toBe("available");
    const pushes = sent.filter((s) => s.state.status === "available");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].channel).toBe("omp:updateState");
    expect(pushes[0].state.installedVersion).toBe("1.0.0");
    expect(pushes[0].state.latestVersion).toBe("1.2.0");
    expect(pushes[0].state.installPath).toBe("/managed/omp");
  });

  it("offers an install (missing, not available) when omp is not installed", async () => {
    const { updater } = makeUpdater({ installPath: null });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("missing");
    const pushes = sent.filter((s) => s.state.status === "missing");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].state.installPath).toBeNull();
    expect(pushes[0].state.installedVersion).toBeNull();
    expect(pushes[0].state.latestVersion).toBe("1.2.0");
  });

  it("stays silent in the background when already current", async () => {
    const { updater } = makeUpdater({ fetchImpl: registryFetch({ version: "1.0.0" }) });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("idle");
    expect(statuses()).toEqual(["checking", "idle"]);
  });

  it("records the resolved install facts when no update is offered (issue #76)", async () => {
    const { updater } = makeUpdater({ fetchImpl: registryFetch({ version: "1.0.0" }) });
    await updater.checkNow(false);
    expect(updater.state.installPath).toBe("/managed/omp");
    expect(updater.state.installedVersion).toBe("1.0.0");
  });

  it("answers a manual same-version check with up-to-date", async () => {
    const { updater } = makeUpdater({ fetchImpl: registryFetch({ version: "1.0.0" }) });
    await updater.checkNow(true);
    expect(updater.state.status).toBe("up-to-date");
    expect(updater.state.installedVersion).toBe("1.0.0");
  });

  it("keeps the locally read version when the registry is unreachable", async () => {
    const { updater } = makeUpdater({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("idle");
    expect(updater.state.installedVersion).toBe("1.0.0");
  });

  it("stays quiet for a dismissed version in the background but answers a manual check", async () => {
    const { updater, dismissed } = makeUpdater();
    dismissed.value = "1.2.0";
    await updater.checkNow(false);
    expect(updater.state.status).toBe("idle");
    expect(statuses()).not.toContain("available");

    sent.length = 0;
    await updater.checkNow(true);
    expect(updater.state.status).toBe("available");
    expect(updater.state.latestVersion).toBe("1.2.0");
  });

  it("re-announces when a newer-than-dismissed version exists", async () => {
    const { updater, dismissed } = makeUpdater({
      fetchImpl: registryFetch({ version: "1.3.0" }),
    });
    dismissed.value = "1.2.0";
    await updater.checkNow(false);
    expect(updater.state.status).toBe("available");
    expect(updater.state.latestVersion).toBe("1.3.0");
  });
});

describe("OmpUpdater.dismiss", () => {
  it("persists the version when remember is true", async () => {
    const { updater, dismissed } = makeUpdater();
    await updater.checkNow(false);
    updater.dismiss("1.2.0", true);
    expect(dismissed.value).toBe("1.2.0");
    expect(updater.state.status).toBe("idle");
    expect(updater.state.latestVersion).toBeNull();
    // Last-known install facts survive the hide.
    expect(updater.state.installPath).toBe("/managed/omp");
    expect(updater.state.installedVersion).toBe("1.0.0");
  });

  it("persists nothing on a transient hide", () => {
    const { updater, dismissed } = makeUpdater();
    updater.dismiss("", false);
    expect(dismissed.value).toBeNull();
    expect(updater.state.status).toBe("idle");
  });
});

describe("OmpUpdater.download", () => {
  it("is a no-op unless an offer is on the table", async () => {
    const downloadFetchImpl = vi.fn();
    const { updater, onApplied } = makeUpdater({ downloadFetchImpl });
    await updater.download(); // idle — never offered
    expect(downloadFetchImpl).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(statuses()).toEqual([]);
  });

  it("streams the download, then reports installed with the binary in place", async () => {
    const target = path.join(mkTmp(), "bin", "omp");
    const payload = Buffer.from("#!/bin/sh\necho omp/1.2.0\n");
    const applied: string[] = [];
    const { updater } = makeUpdater({
      targetPath: target,
      downloadFetchImpl: streamFetch([payload.subarray(0, 5), payload.subarray(5)]),
      onApplied: (v: string) => {
        // The binary must already be in place when the callback fires.
        expect(fs.readFileSync(target)).toEqual(payload);
        applied.push(v);
      },
    });
    await updater.checkNow(false);
    await updater.download();
    expect(applied).toEqual(["1.2.0"]);
    expect(fs.readFileSync(target)).toEqual(payload);
    const seq = statuses();
    expect(seq[0]).toBe("checking");
    expect(seq).toContain("available");
    expect(seq).toContain("downloading");
    expect(seq[seq.length - 1]).toBe("installed");
    const progress = sent
      .filter((s) => s.state.status === "downloading")
      .map((s) => s.state.progress);
    expect(progress[0]).toBeNull(); // the initial downloading push
    expect(progress).toContain(100);
    expect(updater.state.installPath).toBe(target);
    expect(updater.state.installedVersion).toBe("1.2.0");
  });

  it("installs from the missing offer too", async () => {
    const target = path.join(mkTmp(), "omp");
    const payload = Buffer.from("#!/bin/sh\n");
    const { updater, onApplied } = makeUpdater({
      installPath: null,
      targetPath: target,
      downloadFetchImpl: streamFetch([payload]),
    });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("missing");
    await updater.download();
    expect(updater.state.status).toBe("installed");
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(target)).toEqual(payload);
  });

  it("surfaces a failed download as error and leaves the old binary untouched", async () => {
    const dir = mkTmp();
    const target = path.join(dir, "omp");
    fs.writeFileSync(target, "old-binary");
    const { updater, onApplied } = makeUpdater({
      installPath: target,
      targetPath: target,
      downloadFetchImpl: async () => ({
        ok: false,
        status: 500,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    });
    await updater.checkNow(false);
    await updater.download();
    expect(updater.state.status).toBe("error");
    expect(updater.state.error).toContain("500");
    expect(onApplied).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("old-binary");
    expect(fs.readdirSync(dir)).toEqual(["omp"]);
  });

  it("rejects a downloaded body that does not run as omp", async () => {
    const dir = mkTmp();
    const target = path.join(dir, "omp");
    const installPath = "/managed/omp";
    const { updater, onApplied } = makeUpdater({
      installPath,
      targetPath: target,
      // The installed binary reads fine; the downloaded body is garbage.
      runner: async (p) => (p === installPath ? "omp/1.0.0" : "garbage"),
      downloadFetchImpl: streamFetch([Buffer.from("captive-portal-html")]),
    });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("available");
    await updater.download();
    expect(updater.state.status).toBe("error");
    expect(updater.state.error).toMatch(/failed validation/);
    expect(onApplied).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
