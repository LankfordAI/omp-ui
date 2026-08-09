import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFileAtomically } from "./download";
import type { DownloadFetchLike } from "./fetch";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-download-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function arrayBuffer(data: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(data.byteLength);
  new Uint8Array(result).set(data);
  return result;
}

function streamFetch(chunks: Uint8Array[], length: string | null): DownloadFetchLike {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-length" ? length : null) },
    body: {
      getReader: () => {
        let index = 0;
        return {
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true as const },
        };
      },
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("downloadFileAtomically", () => {
  it("streams chunks directly and reports increasing progress ending at 100", async () => {
    const chunks = [bytes("one"), bytes("two-two"), bytes("three")];
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const targetPath = path.join(mkTmp(), "asset.bin");
    const progress: (number | null)[] = [];

    await downloadFileAtomically({
      url: "https://example.test/asset",
      targetPath,
      description: "asset",
      fetchImpl: streamFetch(chunks, String(total)),
      onProgress: (value) => progress.push(value),
    });

    expect(fs.readFileSync(targetPath)).toEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    expect(progress.at(-1)).toBe(100);
    expect(progress.every((value): value is number => value !== null)).toBe(true);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThan(progress[index - 1]!);
    }
    expect(fs.readdirSync(path.dirname(targetPath))).toEqual(["asset.bin"]);
  });

  it("reports indeterminate progress once when content-length is absent", async () => {
    const targetPath = path.join(mkTmp(), "asset.bin");
    const progress: (number | null)[] = [];
    await downloadFileAtomically({
      url: "https://example.test/asset",
      targetPath,
      description: "asset",
      fetchImpl: streamFetch([bytes("payload")], null),
      onProgress: (value) => progress.push(value),
    });
    expect(progress).toEqual([null]);
  });

  it("falls back to arrayBuffer and validates the temporary file before commit", async () => {
    const payload = bytes("payload");
    const targetPath = path.join(mkTmp(), "omp.exe");
    const validateTemp = vi.fn(async (candidate: string) => {
      expect(candidate).toMatch(/\.tmp-[^.]+-[^.]+\.exe$/);
      expect(fs.readFileSync(candidate)).toEqual(Buffer.from(payload));
    });
    await downloadFileAtomically({
      url: "https://example.test/omp",
      targetPath,
      description: "omp",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => arrayBuffer(payload),
      }),
      validateTemp,
    });
    expect(validateTemp).toHaveBeenCalledOnce();
    expect(fs.readFileSync(targetPath)).toEqual(Buffer.from(payload));
  });

  it("rejects a declared size above the cap before creating a temp file", async () => {
    const dir = mkTmp();
    const targetPath = path.join(dir, "asset.bin");
    await expect(
      downloadFileAtomically({
        url: "https://example.test/asset",
        targetPath,
        description: "asset",
        maxBytes: 4,
        fetchImpl: streamFetch([bytes("data")], "5"),
      }),
    ).rejects.toThrow("download exceeds 4 byte limit for asset");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("rejects streamed bytes above the cap when the header lies and preserves the target", async () => {
    const dir = mkTmp();
    const targetPath = path.join(dir, "asset.bin");
    fs.writeFileSync(targetPath, "existing");
    await expect(
      downloadFileAtomically({
        url: "https://example.test/asset",
        targetPath,
        description: "asset",
        maxBytes: 5,
        fetchImpl: streamFetch([bytes("123"), bytes("456")], "4"),
      }),
    ).rejects.toThrow("download exceeds 5 byte limit for asset");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("existing");
    expect(fs.readdirSync(dir)).toEqual(["asset.bin"]);
  });

  it("enforces the cap on an arrayBuffer fallback", async () => {
    const dir = mkTmp();
    const targetPath = path.join(dir, "asset.bin");
    await expect(
      downloadFileAtomically({
        url: "https://example.test/asset",
        targetPath,
        description: "asset",
        maxBytes: 3,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: null,
          arrayBuffer: async () => arrayBuffer(bytes("four")),
        }),
      }),
    ).rejects.toThrow("download exceeds 3 byte limit for asset");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("removes the temp file and preserves the target on checksum mismatch", async () => {
    const dir = mkTmp();
    const targetPath = path.join(dir, "asset.bin");
    fs.writeFileSync(targetPath, "existing");
    await expect(
      downloadFileAtomically({
        url: "https://example.test/asset",
        targetPath,
        description: "asset",
        expectedSha256: crypto.createHash("sha256").update("different").digest("hex"),
        fetchImpl: streamFetch([bytes("payload")], "7"),
      }),
    ).rejects.toThrow("checksum mismatch for asset.bin");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("existing");
    expect(fs.readdirSync(dir)).toEqual(["asset.bin"]);
  });

  it("removes the temp file and preserves the target on validation failure", async () => {
    const dir = mkTmp();
    const targetPath = path.join(dir, "asset.bin");
    fs.writeFileSync(targetPath, "existing");
    await expect(
      downloadFileAtomically({
        url: "https://example.test/asset",
        targetPath,
        description: "asset",
        fetchImpl: streamFetch([bytes("payload")], "7"),
        validateTemp: async () => {
          throw new Error("invalid executable");
        },
      }),
    ).rejects.toThrow("invalid executable");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("existing");
    expect(fs.readdirSync(dir)).toEqual(["asset.bin"]);
  });
});
