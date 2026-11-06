import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./fetch";
import {
  checkOmpUpdate,
  downloadOmp,
  fetchLatestOmpVersion,
  MIN_SUPPORTED_OMP,
  OMP_RELEASE_BASE,
  ompAssetName,
  ompManagerManifestPath,
  stampOmpManager,
  parseOmpVersion,
  readInstalledOmpVersion,
} from "./omp-update";
import { compareVersions } from "./semver";
import { LOGOUT_ACCOUNTS_MIN_OMP } from "./provider-accounts";

// Keep real filesystem behavior while permitting deterministic read failures.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(path.resolve("."), ".tmp-omp-update-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The §1 invariant for core-owned gates: the floor must stay at or above
// every per-feature *_MIN_OMP. Renderer-side gates are guarded by
// renderer/src/lib/harness-floor.test.ts (the barrel is off-limits there).
describe("MIN_SUPPORTED_OMP harness floor", () => {
  it("is at or above LOGOUT_ACCOUNTS_MIN_OMP", () => {
    expect(compareVersions(MIN_SUPPORTED_OMP, LOGOUT_ACCOUNTS_MIN_OMP)).toBeGreaterThanOrEqual(0);
  });
});

describe("stampOmpManager", () => {
  function managedBinary(): string {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, "bin"));
    const bin = path.join(root, "bin", "omp");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    return bin;
  }

  it("writes the ownership manifest at the root containing bin/", () => {
    const bin = managedBinary();
    const root = path.dirname(path.dirname(bin));
    expect(ompManagerManifestPath(bin)).toBe(path.join(root, "manager.json"));
    expect(stampOmpManager(bin, { pinned: false })).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "manager.json"), "utf8"))).toEqual({
      manager: "omp-ui",
      name: "omp-ui",
    });
  });

  it.each([
    '{"manager":"omp-ui","name":"omp-ui"}\n',
    '{\n  "manager": "omp-ui",\n  "name": "My managed omp",\n  "extra": true\n}\n',
    '{"manager":"omp-ui"}',
  ])("leaves an existing own manifest byte-for-byte unchanged: %s", (body) => {
    const bin = managedBinary();
    const file = ompManagerManifestPath(bin);
    fs.writeFileSync(file, body);
    expect(stampOmpManager(bin, { pinned: false })).toBe(true);
    expect(stampOmpManager(bin, { pinned: false })).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it("preserves a foreign manifest and reports the ownership conflict", () => {
    const bin = managedBinary();
    const file = ompManagerManifestPath(bin);
    const body = '{"manager":"other","name":"Another installer"}\n';
    fs.writeFileSync(file, body);
    expect(() => stampOmpManager(bin, { pinned: false })).toThrow(/ownership conflict.*managed by other/);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it.each(["", "{broken", "null", "[]", "{}", '{"manager":null}', '{"manager":""}'])(
    "does not replace an invalid manifest: %s",
    (body) => {
      const bin = managedBinary();
      const file = ompManagerManifestPath(bin);
      fs.writeFileSync(file, body);
      expect(() => stampOmpManager(bin, { pinned: false })).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(body);
    },
  );

  it("preserves an unreadable manifest and surfaces the read error", () => {
    const bin = managedBinary();
    const file = ompManagerManifestPath(bin);
    const body = '{"manager":"other"}';
    fs.writeFileSync(file, body);
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw denied; });
    expect(() => stampOmpManager(bin, { pinned: false })).toThrow(denied);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it("never overwrites a manifest created between reading and stamping", () => {
    const bin = managedBinary();
    const file = ompManagerManifestPath(bin);
    const body = '{"manager":"other"}';
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      fs.writeFileSync(file, body);
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(() => stampOmpManager(bin, { pinned: false })).toThrow(/EEXIST/);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it("never writes under an OMP_UI_OMP_PATH pin or without a binary", () => {
    const bin = managedBinary();
    expect(stampOmpManager(bin, { pinned: true })).toBe(false);
    expect(fs.existsSync(ompManagerManifestPath(bin))).toBe(false);
    const missing = path.join(mkTmp(), "bin", "omp");
    expect(stampOmpManager(missing, { pinned: false })).toBe(false);
    expect(fs.existsSync(ompManagerManifestPath(missing))).toBe(false);
  });
});

describe("parseOmpVersion", () => {
  it("extracts the version from `omp --version` output", () => {
    expect(parseOmpVersion("omp/17.1.8\n")).toBe("17.1.8");
    expect(parseOmpVersion("omp/17.1.8\n\nUSAGE")).toBe("17.1.8");
  });

  it("returns null when the shape is wrong", () => {
    expect(parseOmpVersion("not omp here")).toBeNull();
    expect(parseOmpVersion("")).toBeNull();
  });
});

describe("ompAssetName", () => {
  it("names the release asset per platform/arch", () => {
    expect(ompAssetName("linux", "x64")).toBe("omp-linux-x64");
    expect(ompAssetName("linux", "arm64")).toBe("omp-linux-arm64");
    expect(ompAssetName("darwin", "arm64")).toBe("omp-darwin-arm64");
    expect(ompAssetName("win32", "x64")).toBe("omp-windows-x64.exe");
  });

  it("returns null for unsupported combos", () => {
    expect(ompAssetName("linux", "sparc")).toBeNull();
    expect(ompAssetName("freebsd", "x64")).toBeNull();
  });
});

function okFetch(body: unknown): FetchLike {
  return async () =>
    ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as never;
}

describe("fetchLatestOmpVersion", () => {
  it("returns the registry's latest version", async () => {
    expect(await fetchLatestOmpVersion(okFetch({ version: "17.2.4" }))).toBe("17.2.4");
  });

  it("normalizes a v-prefixed version", async () => {
    expect(await fetchLatestOmpVersion(okFetch({ version: "v17.2.4" }))).toBe("17.2.4");
  });

  it("returns null on HTTP error, bad shape, or throw", async () => {
    expect(await fetchLatestOmpVersion(async () => ({ ok: false, status: 500 }) as never)).toBeNull();
    expect(await fetchLatestOmpVersion(okFetch({ nope: true }))).toBeNull();
    expect(await fetchLatestOmpVersion(async () => { throw new Error("offline"); })).toBeNull();
  });
});

describe("readInstalledOmpVersion", () => {
  it("runs the runner and parses", async () => {
    expect(await readInstalledOmpVersion("/x/omp", async () => "omp/17.1.8")).toBe("17.1.8");
  });

  it("returns null when the runner throws", async () => {
    expect(await readInstalledOmpVersion("/x/omp", async () => { throw new Error("no"); })).toBeNull();
  });
});

describe("downloadOmp", () => {
  it("writes the fetched body atomically to the target", async () => {
    const target = path.join(mkTmp(), "bin", "omp");
    const seenUrls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("#!/bin/sh\n").buffer,
      };
    };
    await downloadOmp({ version: "17.2.4", targetPath: target, fetchImpl, verifyRunner: null });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("#!/bin/sh\n");
    // The URL points at the exact GitHub release asset for this host, v-prefixed.
    expect(seenUrls).toEqual([`${OMP_RELEASE_BASE}/v17.2.4/${ompAssetName()}`]);
  });

  it("leaves no temp file behind", async () => {
    const dir = mkTmp();
    const target = path.join(dir, "omp");
    await downloadOmp({
      version: "1.0.0",
      targetPath: target,
      fetchImpl: okFetch({}),
      verifyRunner: null,
    });
    expect(fs.readdirSync(dir)).toEqual(["omp"]);
  });

  it("commits the rename only when the download runs as omp", async () => {
    let ran = false;
    const target = path.join(mkTmp(), "omp");
    await downloadOmp({
      version: "1.0.0",
      targetPath: target,
      fetchImpl: okFetch({}),
      verifyRunner: async () => {
        ran = true;
        return "omp/1.0.0";
      },
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("keeps an .exe suffix while validating a Windows managed binary", async () => {
    const target = path.join(mkTmp(), "omp.exe");
    let validated = "";
    await downloadOmp({
      version: "1.0.0",
      targetPath: target,
      fetchImpl: okFetch({}),
      verifyRunner: async (candidate) => {
        validated = candidate;
        return "omp/1.0.0";
      },
    });
    expect(validated).toMatch(/\.tmp-[^.]+-[^.]+\.exe$/);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("unlinks a download that fails validation and leaves no target", async () => {
    const dir = mkTmp();
    const target = path.join(dir, "omp");
    await expect(
      downloadOmp({ version: "1.0.0", targetPath: target, fetchImpl: okFetch({}), verifyRunner: async () => "not-a-real-version" }),
    ).rejects.toThrow(/failed validation/);
    expect(fs.existsSync(target)).toBe(false);
    // No tmp files left either.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

});

describe("checkOmpUpdate", () => {
  it("reports an update when installed < latest", async () => {
    const info = await checkOmpUpdate({
      installPath: "/managed/omp",
      runner: async () => "omp/17.1.8",
      fetchImpl: okFetch({ version: "17.2.4" }),
    });
    expect(info.installedVersion).toBe("17.1.8");
    expect(info.latestVersion).toBe("17.2.4");
    expect(info.updateAvailable).toBe(true);
    expect(info.error).toBeNull();
  });

  it("reports no update on a tie or when newer than latest", async () => {
    const onTie = await checkOmpUpdate({
      installPath: "/m/omp",
      runner: async () => "omp/17.2.4",
      fetchImpl: okFetch({ version: "17.2.4" }),
    });
    expect(onTie.updateAvailable).toBe(false);

    const newer = await checkOmpUpdate({
      installPath: "/m/omp",
      runner: async () => "omp/17.3.0",
      fetchImpl: okFetch({ version: "17.2.4" }),
    });
    expect(newer.updateAvailable).toBe(false);
  });

  it("surfaces no-update when omp is absent", async () => {
    const info = await checkOmpUpdate({
      installPath: null,
      fetchImpl: okFetch({ version: "17.2.4" }),
    });
    expect(info.installPath).toBeNull();
    expect(info.installedVersion).toBeNull();
    expect(info.updateAvailable).toBe(false);
  });

  describe("belowMinimum", () => {
    it("is true below the floor and false at or above it", async () => {
      // Floor-minus-one: step the patch down, borrowing from the minor.
      const [maj, min, patch] = MIN_SUPPORTED_OMP.split(".").map(Number);
      const belowVersion =
        patch > 0 ? `${maj}.${min}.${patch - 1}` : `${maj}.${min - 1}.999`;
      const below = await checkOmpUpdate({
        installPath: "/m/omp",
        runner: async () => `omp/${belowVersion}`,
        fetchImpl: okFetch({ version: "99.0.0" }),
      });
      expect(below.belowMinimum).toBe(true);

      const at = await checkOmpUpdate({
        installPath: "/m/omp",
        runner: async () => `omp/${MIN_SUPPORTED_OMP}`,
        fetchImpl: okFetch({ version: "99.0.0" }),
      });
      expect(at.belowMinimum).toBe(false);

      const above = await checkOmpUpdate({
        installPath: "/m/omp",
        runner: async () => "omp/99.0.0",
        fetchImpl: okFetch({ version: "99.0.0" }),
      });
      expect(above.belowMinimum).toBe(false);
    });

    it("is false when no binary resolves or the version read fails", async () => {
      const none = await checkOmpUpdate({
        installPath: null,
        fetchImpl: okFetch({ version: "99.0.0" }),
      });
      expect(none.belowMinimum).toBe(false);

      const unreadable = await checkOmpUpdate({
        installPath: "/m/omp",
        runner: async () => {
          throw new Error("not executable");
        },
        fetchImpl: okFetch({ version: "99.0.0" }),
      });
      expect(unreadable.installedVersion).toBeNull();
      expect(unreadable.belowMinimum).toBe(false);
    });
  });
});
