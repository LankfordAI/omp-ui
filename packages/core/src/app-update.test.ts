import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_RELEASE_DOWNLOAD_BASE,
  detectPackageFormat,
  downloadAppAsset,
  expectedAssetName,
  fetchLatestAppRelease,
  fetchSha256Sums,
  parseLatestRelease,
  parseSha256Sums,
  selectAsset,
  sha256Hex,
  type AppReleaseInfo,
  type DownloadFetchLike,
} from "./app-update";
import type { FetchLike } from "./omp-update";

/** Exact-ArrayBuffer copy (Buffer/Uint8Array `.buffer` types as ArrayBufferLike). */
const toArrayBuffer = (data: Uint8Array): ArrayBuffer => {
  const ab = new ArrayBuffer(data.length);
  new Uint8Array(ab).set(data);
  return ab;
};

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-app-update-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RELEASE_BODY = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/LankfordAI/omp-ui/releases/tag/v1.2.3",
  name: "omp-ui 1.2.3",
  draft: false,
  prerelease: false,
  assets: [
    { name: "omp-ui-1.2.3.AppImage" },
    { name: "omp-ui_1.2.3_amd64.deb" },
    { name: "omp-ui-1.2.3.x86_64.rpm" },
    { name: "omp-ui-1.2.3-x86_64.flatpak" },
    { name: "SHA256SUMS.txt" },
  ],
};

describe("parseLatestRelease", () => {
  it("parses a valid payload, normalizing the version and mapping asset names", () => {
    expect(parseLatestRelease(RELEASE_BODY)).toEqual({
      version: "1.2.3",
      tag: "v1.2.3",
      url: "https://github.com/LankfordAI/omp-ui/releases/tag/v1.2.3",
      name: "omp-ui 1.2.3",
      assets: [
        "omp-ui-1.2.3.AppImage",
        "omp-ui_1.2.3_amd64.deb",
        "omp-ui-1.2.3.x86_64.rpm",
        "omp-ui-1.2.3-x86_64.flatpak",
        "SHA256SUMS.txt",
      ],
    });
  });

  it("returns null for drafts and prereleases", () => {
    expect(parseLatestRelease({ ...RELEASE_BODY, draft: true })).toBeNull();
    expect(parseLatestRelease({ ...RELEASE_BODY, prerelease: true })).toBeNull();
  });

  it("returns null when tag_name is missing or unparseable", () => {
    const { tag_name: _dropped, ...noTag } = RELEASE_BODY;
    expect(parseLatestRelease(noTag)).toBeNull();
    expect(parseLatestRelease({ ...RELEASE_BODY, tag_name: 42 })).toBeNull();
    expect(parseLatestRelease({ ...RELEASE_BODY, tag_name: "not-a-version" })).toBeNull();
  });

  it("returns null when html_url is missing", () => {
    const { html_url: _dropped, ...noUrl } = RELEASE_BODY;
    expect(parseLatestRelease(noUrl)).toBeNull();
    expect(parseLatestRelease({ ...RELEASE_BODY, html_url: 42 })).toBeNull();
  });

  it("treats a non-array assets field as empty and a non-string name as null", () => {
    const info = parseLatestRelease({ ...RELEASE_BODY, assets: "nope", name: 7 });
    expect(info).not.toBeNull();
    expect(info!.assets).toEqual([]);
    expect(info!.name).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease("v1.2.3")).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
  });
});

function okFetch(body: unknown): FetchLike {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode(JSON.stringify(body))),
    }) as never;
}

describe("fetchLatestAppRelease", () => {
  it("returns the parsed release on success", async () => {
    const info = await fetchLatestAppRelease(okFetch(RELEASE_BODY));
    expect(info?.version).toBe("1.2.3");
    expect(info?.tag).toBe("v1.2.3");
  });

  it("returns null on HTTP errors (rate limit, no stable release)", async () => {
    expect(
      await fetchLatestAppRelease(async () => ({ ok: false, status: 403 }) as never),
    ).toBeNull();
    expect(
      await fetchLatestAppRelease(async () => ({ ok: false, status: 404 }) as never),
    ).toBeNull();
  });

  it("returns null when fetch throws or the body is malformed", async () => {
    expect(
      await fetchLatestAppRelease(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
    expect(await fetchLatestAppRelease(okFetch({ nope: true }))).toBeNull();
  });
});

describe("detectPackageFormat", () => {
  const none = (): boolean => false;

  it("detects each format from env/existence evidence", () => {
    expect(detectPackageFormat({ APPIMAGE: "/run/omp-ui.AppImage" }, none)).toBe("appimage");
    expect(detectPackageFormat({}, (p) => p === "/.flatpak-info")).toBe("flatpak");
    expect(detectPackageFormat({}, (p) => p === "/usr/bin/dpkg")).toBe("deb");
    expect(detectPackageFormat({}, (p) => p === "/usr/bin/rpm")).toBe("rpm");
  });

  it("applies appimage > flatpak > deb > rpm precedence", () => {
    const all = (): boolean => true;
    expect(detectPackageFormat({ APPIMAGE: "/x" }, all)).toBe("appimage");
    expect(detectPackageFormat({}, all)).toBe("flatpak");
    expect(detectPackageFormat({}, (p) => p !== "/.flatpak-info")).toBe("deb");
    expect(detectPackageFormat({}, (p) => p === "/usr/bin/rpm")).toBe("rpm");
  });

  it("falls back to unknown with no evidence", () => {
    expect(detectPackageFormat({}, none)).toBe("unknown");
  });
});

describe("expectedAssetName", () => {
  it("names the exact release.yml artifacts for 1.2.3", () => {
    expect(expectedAssetName("deb", "1.2.3")).toBe("omp-ui_1.2.3_amd64.deb");
    expect(expectedAssetName("rpm", "1.2.3")).toBe("omp-ui-1.2.3.x86_64.rpm");
    expect(expectedAssetName("flatpak", "1.2.3")).toBe("omp-ui-1.2.3-x86_64.flatpak");
  });
});

function releaseWith(assets: string[]): AppReleaseInfo {
  return {
    version: "1.2.3",
    tag: "v1.2.3",
    url: "https://example.test/release",
    name: null,
    assets,
  };
}

describe("selectAsset", () => {
  it("returns the exact expected asset name", () => {
    const release = releaseWith(["omp-ui-1.2.3.AppImage", "omp-ui_1.2.3_amd64.deb"]);
    expect(selectAsset(release, "deb")).toBe("omp-ui_1.2.3_amd64.deb");
  });

  it("rejects near-miss names — suffix similarity is never enough", () => {
    const release = releaseWith(["omp-ui_1.2.4-beta_amd64.deb", "omp-ui_1.2.3_amd64.deb.sig"]);
    expect(selectAsset(release, "deb")).toBeNull();
  });

  it("returns null when the expected asset is absent", () => {
    expect(selectAsset(releaseWith(["omp-ui-1.2.3.AppImage"]), "rpm")).toBeNull();
  });
});

describe("parseSha256Sums", () => {
  it("parses sha256sum output, skipping blank lines", () => {
    const sums = parseSha256Sums(
      [
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  omp-ui-1.2.3.AppImage",
        "",
        "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34  omp-ui_1.2.3_amd64.deb",
        "   ",
      ].join("\n"),
    );
    expect(sums.get("omp-ui-1.2.3.AppImage")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sums.get("omp-ui_1.2.3_amd64.deb")).toBe(
      "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34",
    );
    expect(sums.size).toBe(2);
  });
});

describe("fetchSha256Sums", () => {
  const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("fetches and parses the tag's SHA256SUMS.txt", async () => {
    const seenUrls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          toArrayBuffer(new TextEncoder().encode(`${ABC_SHA}  omp-ui_1.2.3_amd64.deb\n`)),
      };
    };
    const sums = await fetchSha256Sums("v1.2.3", fetchImpl);
    expect(seenUrls).toEqual([`${APP_RELEASE_DOWNLOAD_BASE}/v1.2.3/SHA256SUMS.txt`]);
    expect(sums?.get("omp-ui_1.2.3_amd64.deb")).toBe(ABC_SHA);
  });

  it("returns null on HTTP error or throw", async () => {
    expect(
      await fetchSha256Sums("v1.2.3", async () => ({ ok: false, status: 404 }) as never),
    ).toBeNull();
    expect(
      await fetchSha256Sums("v1.2.3", async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for 'abc'", async () => {
    expect(await sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

/** Chunks `data` into `n` pieces behind a streaming DownloadFetchLike double. */
function streamFetch(data: Buffer, n: number, withLength = true): DownloadFetchLike {
  const size = Math.ceil(data.length / n);
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += size) chunks.push(data.subarray(off, off + size));
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-length" && withLength ? String(data.length) : null) },
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true as const, value: undefined },
        };
      },
    },
    arrayBuffer: async () => toArrayBuffer(data),
  });
}

describe("downloadAppAsset", () => {
  const PAYLOAD = Buffer.from("omp-ui release artifact bytes\n".repeat(16));
  let payloadSha: string;

  it("streams chunks to the target with strictly increasing progress ending at 100", async () => {
    payloadSha = await sha256Hex(PAYLOAD);
    const dir = mkTmp();
    const target = path.join(dir, "omp-ui_1.2.3_amd64.deb");
    const progress: (number | null)[] = [];
    await downloadAppAsset({
      url: "https://example.test/asset",
      targetPath: target,
      expectedSha256: payloadSha,
      fetchImpl: streamFetch(PAYLOAD, 3),
      onProgress: (p) => progress.push(p),
    });
    expect(fs.readFileSync(target)).toEqual(PAYLOAD);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    for (const p of progress) expect(typeof p).toBe("number");
    const nums = progress as number[];
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    }
    expect(nums[nums.length - 1]).toBe(100);
  });

  it("throws on checksum mismatch, leaving no target and no tmp file", async () => {
    const dir = mkTmp();
    const target = path.join(dir, "omp-ui_1.2.3_amd64.deb");
    await expect(
      downloadAppAsset({
        url: "https://example.test/asset",
        targetPath: target,
        expectedSha256: "0".repeat(64),
        fetchImpl: streamFetch(PAYLOAD, 2),
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("throws on HTTP failure", async () => {
    const target = path.join(mkTmp(), "asset.deb");
    await expect(
      downloadAppAsset({
        url: "https://example.test/asset",
        targetPath: target,
        expectedSha256: "0".repeat(64),
        fetchImpl: async () =>
          ({ ok: false, status: 404, headers: { get: () => null }, body: null }) as never,
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("falls back to arrayBuffer when the body is null", async () => {
    payloadSha = await sha256Hex(PAYLOAD);
    const target = path.join(mkTmp(), "asset.deb");
    const fetchImpl: DownloadFetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => toArrayBuffer(PAYLOAD),
    });
    await downloadAppAsset({
      url: "https://example.test/asset",
      targetPath: target,
      expectedSha256: payloadSha,
      fetchImpl,
    });
    expect(fs.readFileSync(target)).toEqual(PAYLOAD);
  });

  it("reports indeterminate progress when content-length is absent", async () => {
    payloadSha = await sha256Hex(PAYLOAD);
    const target = path.join(mkTmp(), "asset.deb");
    const progress: (number | null)[] = [];
    await downloadAppAsset({
      url: "https://example.test/asset",
      targetPath: target,
      expectedSha256: payloadSha,
      fetchImpl: streamFetch(PAYLOAD, 2, false),
      onProgress: (p) => progress.push(p),
    });
    expect(progress).toEqual([null]);
  });
});
