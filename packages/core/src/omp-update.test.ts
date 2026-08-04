import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DownloadFetchLike } from "./app-update";
import {
  checkOmpUpdate,
  compareVersions,
  downloadOmp,
  fetchLatestOmpVersion,
  OMP_RELEASE_BASE,
  ompAssetName,
  parseOmpVersion,
  parseSemver,
  readInstalledOmpVersion,
  type FetchLike,
} from "./omp-update";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(path.resolve("."), ".tmp-omp-update-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseSemver", () => {
  it("parses X.Y.Z with or without a v prefix", () => {
    expect(parseSemver("17.1.8")).toEqual({ major: 17, minor: 1, patch: 8 });
    expect(parseSemver("v17.2.4")).toEqual({ major: 17, minor: 2, patch: 4 });
  });

  it("rejects non-semver input", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
    expect(parseSemver("17")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("17.1.8", "17.2.4")).toBeLessThan(0);
    expect(compareVersions("17.2.4", "17.1.8")).toBeGreaterThan(0);
    expect(compareVersions("17.2.4", "17.2.4")).toBe(0);
    expect(compareVersions("18.0.0", "17.99.0")).toBeGreaterThan(0);
    expect(compareVersions("17.2.0", "17.2.5")).toBeLessThan(0);
  });

  it("treats unparseable input as lowest", () => {
    expect(compareVersions("", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "garbage")).toBeGreaterThan(0);
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

  it("fires onProgress with ascending percentages ending at 100 for a streamed body", async () => {
    const target = path.join(mkTmp(), "omp");
    const chunks = ["#!/bin/", "sh\necho ", "omp/1.0", ".0\n"].map((s) => new TextEncoder().encode(s));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const fetchImpl: DownloadFetchLike = async () => ({
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
    const seen: (number | null)[] = [];
    await downloadOmp({
      version: "1.0.0",
      targetPath: target,
      fetchImpl,
      verifyRunner: null,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toHaveLength(chunks.length);
    expect(seen.every((p): p is number => p !== null)).toBe(true);
    expect(seen[seen.length - 1]).toBe(100);
    const sorted = [...(seen as number[])].sort((a, b) => a - b);
    expect(seen).toEqual(sorted);
    expect(fs.readFileSync(target)).toEqual(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  });

  it("fires onProgress(null) and still installs when the body has no content-length", async () => {
    const target = path.join(mkTmp(), "omp");
    const seen: (number | null)[] = [];
    await downloadOmp({
      version: "1.0.0",
      targetPath: target,
      fetchImpl: okFetch({}),
      verifyRunner: null,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([null]);
    expect(fs.existsSync(target)).toBe(true);
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
});
