import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  sha256Hex,
  type AppUpdateState,
  type DownloadFetchLike,
  type FetchLike,
} from "@omp-ui/core";
import type { AppUpdaterDeps, AppUpdater as AppUpdaterType, AutoUpdaterLike } from "./app-update";

// app-update.ts touches only electron's `shell`; stub it and capture calls.
const shellMock = {
  openExternal: vi.fn(async () => {}),
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
};
vi.mock("electron", () => ({ shell: shellMock }));

const { AppUpdater, resolveAutoUpdater } = await import("./app-update");

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-app-updater-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Exact-ArrayBuffer copy (Buffer/Uint8Array `.buffer` types as ArrayBufferLike). */
const toArrayBuffer = (data: Uint8Array): ArrayBuffer => {
  const ab = new ArrayBuffer(data.length);
  new Uint8Array(ab).set(data);
  return ab;
};

const sent: { channel: string; state: AppUpdateState }[] = [];

function releaseBody(version: string): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/LankfordAI/omp-ui/releases/tag/v${version}`,
    name: `omp-ui ${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `omp-ui-${version}.AppImage` },
      { name: `omp-ui_${version}_amd64.deb` },
      { name: `omp-ui-${version}.x86_64.rpm` },
      { name: `omp-ui-${version}-x86_64.flatpak` },
    ],
  };
}

/**
 * Routes the two GETs the updater makes: the latest-release JSON and the
 * tag's SHA256SUMS.txt. `sumsText: null` answers the sums request with a 404.
 */
function updateFetch(opts: { releaseBody?: unknown; sumsText?: string | null }): FetchLike {
  return async (url) => {
    const notFound = {
      ok: false,
      status: 404,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    if (url.includes("/releases/latest")) {
      if (opts.releaseBody === undefined) return notFound;
      const body = opts.releaseBody;
      return {
        ok: true,
        status: 200,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (opts.sumsText == null) return notFound;
    const text = opts.sumsText;
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode(text)),
    };
  };
}

/** Single-chunk streaming download double carrying a content-length. */
function streamFetch(data: Buffer): DownloadFetchLike {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-length" ? String(data.length) : null) },
    body: {
      getReader: () => {
        let sentChunk = false;
        return {
          read: async () => {
            if (sentChunk) return { done: true };
            sentChunk = true;
            return { done: false, value: data };
          },
        };
      },
    },
    arrayBuffer: async () => toArrayBuffer(data),
  });
}

interface MadeUpdater {
  updater: AppUpdaterType;
  downloadsDir: string;
  dismissed: { value: string | null };
  confirmQuit: Mock<() => Promise<boolean>>;
}

function makeUpdater(overrides: Partial<AppUpdaterDeps> = {}): MadeUpdater {
  const dismissed = { value: null as string | null };
  const confirmQuit = vi.fn(async () => true);
  const downloadsDir = mkTmp();
  const updater = new AppUpdater({
    win: {} as never,
    enabled: true,
    currentVersion: "1.0.0",
    downloadsDir,
    getDismissed: () => dismissed.value,
    setDismissed: (v) => {
      dismissed.value = v;
    },
    confirmQuit,
    send: (channel, state) => sent.push({ channel, state: { ...state } }),
    channel: "app:updateState",
    ...overrides,
  });
  return { updater, downloadsDir, dismissed, confirmQuit };
}

const statuses = (): AppUpdateState["status"][] => sent.map((s) => s.state.status);

beforeEach(() => {
  sent.length = 0;
  vi.clearAllMocks();
});

describe("AppUpdater.checkNow", () => {
  it("stays quiet on background network failure — no error push, final state idle", async () => {
    const { updater } = makeUpdater({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await updater.checkNow(false);
    expect(statuses()).not.toContain("error");
    expect(statuses()).not.toContain("available");
    expect(updater.state.status).toBe("idle");
  });

  it("pushes available with versions, url, and format for a newer release", async () => {
    const { updater } = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0") }),
      env: {},
      exists: (p) => p === "/usr/bin/dpkg",
    });
    await updater.checkNow(false);
    const available = sent.filter((s) => s.state.status === "available");
    expect(available).toHaveLength(1);
    expect(available[0].state.latestVersion).toBe("1.2.0");
    expect(available[0].state.currentVersion).toBe("1.0.0");
    expect(available[0].state.releaseUrl).toBe(
      "https://github.com/LankfordAI/omp-ui/releases/tag/v1.2.0",
    );
    expect(available[0].state.format).toBe("deb");
  });

  it("never announces a same-version background check", async () => {
    const { updater } = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.0.0") }),
    });
    await updater.checkNow(false);
    expect(statuses()).not.toContain("up-to-date");
    expect(statuses()).not.toContain("available");
    expect(updater.state.status).toBe("idle");
  });

  it("answers a manual same-version check with up-to-date", async () => {
    const { updater } = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.0.0") }),
    });
    await updater.checkNow(true);
    expect(statuses()).toContain("up-to-date");
  });

  it("answers a manual unreachable check with an error", async () => {
    const { updater } = makeUpdater({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await updater.checkNow(true);
    expect(statuses()).toContain("error");
    expect(updater.state.error).toBe("could not reach GitHub");
  });

  it("suppresses the dismissed version in the background but not manually", async () => {
    const fetchImpl = updateFetch({ releaseBody: releaseBody("1.2.0") });
    const { updater, dismissed } = makeUpdater({ fetchImpl });
    dismissed.value = "1.2.0";

    await updater.checkNow(false);
    expect(statuses()).not.toContain("available");
    expect(updater.state.status).toBe("idle");

    await updater.checkNow(true);
    expect(statuses()).toContain("available");
  });

  it("announces when the dismissed version is older than the latest", async () => {
    const { updater, dismissed } = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.3.0") }),
    });
    dismissed.value = "1.2.0";
    await updater.checkNow(false);
    expect(statuses()).toContain("available");
  });

  it("does nothing in the background and reports disabled manually when off", async () => {
    const { updater } = makeUpdater({
      enabled: false,
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0") }),
    });
    await updater.checkNow(false);
    expect(sent).toHaveLength(0);
    await updater.checkNow(true);
    expect(statuses()).toEqual(["disabled"]);
  });

  it("marks dev/unversioned builds disabled even when enabled is passed", async () => {
    const fetchImpl = updateFetch({ releaseBody: releaseBody("1.2.0") });
    for (const currentVersion of ["0.0.0", "dev-build"]) {
      const { updater } = makeUpdater({ currentVersion, fetchImpl });
      await updater.checkNow(false);
      expect(sent).toHaveLength(0);
      await updater.checkNow(true);
      expect(updater.state.status).toBe("disabled");
      sent.length = 0;
    }
  });
});

describe("AppUpdater.dismiss", () => {
  it("persists the version only when remember is set", async () => {
    const { updater, dismissed } = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0") }),
    });
    await updater.checkNow(false);
    expect(updater.state.status).toBe("available");

    updater.dismiss("1.2.0", true);
    expect(dismissed.value).toBe("1.2.0");
    expect(updater.state.status).toBe("idle");
    expect(updater.state.latestVersion).toBeNull();

    updater.dismiss("", false);
    expect(dismissed.value).toBe("1.2.0"); // unchanged — nothing persisted for ""
  });
});

describe("AppUpdater dismissal reaping (issue #88)", () => {
  /** Constructs an updater whose registry already holds `dismissedVersion`. */
  const makeSeeded = (dismissedVersion: string, currentVersion = "1.0.0"): { value: string | null } => {
    const cell = { value: dismissedVersion as string | null };
    makeUpdater({
      currentVersion,
      getDismissed: () => cell.value,
      setDismissed: (v) => {
        cell.value = v;
      },
    });
    return cell;
  };

  it("drops a dismissal older than the running build", () => {
    expect(makeSeeded("0.9.0").value).toBeNull();
  });

  it("drops a dismissal equal to the running build", () => {
    expect(makeSeeded("1.0.0").value).toBeNull();
  });

  it("keeps a dismissal newer than the running build — it still suppresses that offer", () => {
    expect(makeSeeded("1.2.0").value).toBe("1.2.0");
  });

  it("keeps the dismissal on unversioned builds, which never compare as caught up", () => {
    expect(makeSeeded("0.9.0", "0.0.0").value).toBe("0.9.0");
  });
});

describe("AppUpdater.download (deb/rpm/flatpak)", () => {
  const PAYLOAD = Buffer.from("fake .deb payload bytes");

  async function availableDeb(sumsText: string | null): Promise<MadeUpdater> {
    const made = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0"), sumsText }),
      downloadFetchImpl: streamFetch(PAYLOAD),
      env: {},
      exists: (p) => p === "/usr/bin/dpkg",
    });
    await made.updater.checkNow(false);
    expect(made.updater.state.status).toBe("available");
    return made;
  }

  it("downloads the verified asset, reports progress, and opens the installer", async () => {
    const sums = `${await sha256Hex(PAYLOAD)}  omp-ui_1.2.0_amd64.deb\n`;
    const { updater, downloadsDir } = await availableDeb(sums);
    sent.length = 0;
    await updater.download();

    const target = path.join(downloadsDir, "omp-ui_1.2.0_amd64.deb");
    expect(fs.readFileSync(target)).toEqual(PAYLOAD);
    expect(updater.state.status).toBe("downloaded");
    expect(updater.state.downloadedPath).toBe(target);
    expect(shellMock.openPath).toHaveBeenCalledWith(target);
    const progressPushes = sent.filter(
      (s) => s.state.status === "downloading" && typeof s.state.progress === "number",
    );
    expect(progressPushes.length).toBeGreaterThan(0);
    expect(progressPushes[progressPushes.length - 1].state.progress).toBe(100);
  });

  it("fails closed when the release carries no SHA256SUMS.txt", async () => {
    const { updater, downloadsDir } = await availableDeb(null);
    await updater.download();
    expect(updater.state.status).toBe("error");
    expect(updater.state.error).toBe("release checksums unavailable");
    expect(fs.readdirSync(downloadsDir)).toEqual([]);
  });

  it("is a no-op unless an update is available", async () => {
    const { updater } = makeUpdater();
    await updater.download();
    expect(sent).toHaveLength(0);
  });
});

/** electron-updater double with manual event emission. */
interface FakeAutoUpdater extends AutoUpdaterLike {
  checkForUpdates: Mock<() => Promise<{ isUpdateAvailable: boolean }>>;
  downloadUpdate: Mock<() => Promise<unknown>>;
  quitAndInstall: Mock<() => void>;
  emitProgress: (percent: number) => void;
  emitDownloaded: () => void;
}

function makeFakeAutoUpdater(): FakeAutoUpdater {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event: string, cb: (arg: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true })),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    emitProgress: (percent) =>
      listeners.get("download-progress")?.forEach((cb) => cb({ percent })),
    emitDownloaded: () =>
      listeners.get("update-downloaded")?.forEach((cb) => cb({ version: "1.2.0" })),
  } as FakeAutoUpdater;
}

describe("AppUpdater AppImage path", () => {
  async function availableAppImage(autoUpdater: AutoUpdaterLike): Promise<MadeUpdater> {
    const made = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0") }),
      autoUpdaterFactory: async () => autoUpdater,
      env: { APPIMAGE: "/run/omp-ui.AppImage" },
      exists: () => false,
    });
    await made.updater.checkNow(false);
    expect(made.updater.state.format).toBe("appimage");
    return made;
  }

  it("downloads through electron-updater with autoDownload off", async () => {
    const autoUpdater = makeFakeAutoUpdater();
    const { updater } = await availableAppImage(autoUpdater);
    sent.length = 0;

    await updater.download();
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled();

    autoUpdater.emitProgress(42);
    expect(sent.some((s) => s.state.status === "downloading" && s.state.progress === 42)).toBe(true);
    autoUpdater.emitDownloaded();
    expect(updater.state.status).toBe("downloaded");
    expect(updater.state.progress).toBeNull();
  });

  it("restarts only after the live-session quit guard agrees", async () => {
    const autoUpdater = makeFakeAutoUpdater();
    const { updater, confirmQuit } = await availableAppImage(autoUpdater);
    await updater.download();
    autoUpdater.emitDownloaded();
    expect(updater.state.status).toBe("downloaded");

    confirmQuit.mockResolvedValueOnce(false);
    await updater.restart();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    await updater.restart();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("ignores restart unless an AppImage update is downloaded", async () => {
    const autoUpdater = makeFakeAutoUpdater();
    const { updater } = await availableAppImage(autoUpdater);
    await updater.restart(); // still "available", not downloaded
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("surfaces a factory failure on the card instead of rejecting (issue #87)", async () => {
    const made = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0") }),
      autoUpdaterFactory: async () => {
        throw new Error("electron-updater export unavailable");
      },
      env: { APPIMAGE: "/run/omp-ui.AppImage" },
      exists: () => false,
    });
    await made.updater.checkNow(false);
    sent.length = 0;

    await made.updater.download(); // must resolve, not reject
    expect(made.updater.state.status).toBe("error");
    expect(made.updater.state.error).toBe("electron-updater export unavailable");
  });

  it("surfaces a factory that resolves without an updater (the #87 import shape)", async () => {
    const made = makeUpdater({
      fetchImpl: updateFetch({ releaseBody: releaseBody("1.2.0") }),
      autoUpdaterFactory: (async () => undefined) as never,
      env: { APPIMAGE: "/run/omp-ui.AppImage" },
      exists: () => false,
    });
    await made.updater.checkNow(false);
    sent.length = 0;

    await made.updater.download();
    expect(made.updater.state.status).toBe("error");
    expect(made.updater.state.error).toContain("autoDownload");
  });
});

describe("resolveAutoUpdater", () => {
  it("unwraps the CJS default export (real electron-updater shape, issue #87)", () => {
    const autoUpdater = makeFakeAutoUpdater();
    // cjs-module-lexer misses the lazy arrow getter: the namespace carries
    // every export except autoUpdater, which only default exposes.
    const namespace = { AppImageUpdater: class {}, default: { autoUpdater } };
    expect(resolveAutoUpdater(namespace)).toBe(autoUpdater);
  });

  it("takes a proper named export when the interop layer provides one", () => {
    const autoUpdater = makeFakeAutoUpdater();
    expect(resolveAutoUpdater({ autoUpdater })).toBe(autoUpdater);
  });

  it("returns null for namespaces without an updater anywhere", () => {
    expect(resolveAutoUpdater({ default: {} })).toBeNull();
    expect(resolveAutoUpdater({})).toBeNull();
    expect(resolveAutoUpdater(null)).toBeNull();
    expect(resolveAutoUpdater("electron-updater")).toBeNull();
  });
});
