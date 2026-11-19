import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSpillFile } from "./spill-read";
import { spillRootForTranscript, transcriptSpillCapable } from "./spill-header";
import { parseSpillReference, SPILL_READ_MAX_BYTES, supportsSpillRead } from "./spill";

describe("supportsSpillRead", () => {
  it("gates at omp 19 exactly", () => {
    expect(supportsSpillRead("19.0.0")).toBe(true);
    expect(supportsSpillRead("19.1.2")).toBe(true);
    expect(supportsSpillRead("18.22.2")).toBe(false);
    expect(supportsSpillRead(null)).toBe(false);
  });
});

describe("parseSpillReference", () => {
  it("reads the truncation carrier with its sample flag", () => {
    expect(parseSpillReference({ meta: { truncation: { artifactId: "0" } } })).toEqual({ id: 0, sample: false });
    expect(
      parseSpillReference({ meta: { truncation: { artifactId: 12, artifactElidedBytes: 4096 } } }),
    ).toEqual({ id: 12, sample: true });
    expect(parseSpillReference({ meta: { truncation: { artifactId: "7", artifactElidedBytes: 0 } } })).toEqual({
      id: 7,
      sample: false,
    });
  });

  it("reads the column-cap and minimizer carriers", () => {
    expect(parseSpillReference({ meta: { limits: { columnTruncated: { artifactId: "3" } } } })).toEqual({
      id: 3,
      sample: false,
    });
    expect(parseSpillReference({ meta: { minimized: { filter: "git", inputBytes: 9, outputBytes: 2, artifactId: "5" } } })).toEqual(
      { id: 5, sample: false },
    );
  });

  it("prefers the truncation carrier when several name spills", () => {
    const details = { meta: { truncation: { artifactId: "1" }, minimized: { artifactId: "2" } } };
    expect(parseSpillReference(details)).toEqual({ id: 1, sample: false });
  });

  it("drops malformed shapes without poisoning siblings", () => {
    expect(parseSpillReference(undefined)).toBeUndefined();
    expect(parseSpillReference(null)).toBeUndefined();
    expect(parseSpillReference({})).toBeUndefined();
    expect(parseSpillReference({ meta: null })).toBeUndefined();
    expect(parseSpillReference({ meta: { truncation: { artifactId: "07x" } } })).toBeUndefined();
    expect(parseSpillReference({ meta: { truncation: { artifactId: "-1" } } })).toBeUndefined();
    expect(parseSpillReference({ meta: { truncation: {} } })).toBeUndefined();
    // A failed save (artifactError) leaves every carrier without an id.
    expect(parseSpillReference({ meta: { artifactError: "write", truncation: {} } })).toBeUndefined();
  });

  it("rejects unsafe numeric ids", () => {
    expect(parseSpillReference({ meta: { truncation: { artifactId: 1.5 } } })).toBeUndefined();
    expect(parseSpillReference({ meta: { truncation: { artifactId: Number.MAX_SAFE_INTEGER + 1 } } })).toBeUndefined();
  });
});

describe("spillRootForTranscript", () => {
  it("strips active and archive suffixes to the sibling local root", () => {
    const expected = path.join("/s", "2026_t", "local");
    expect(spillRootForTranscript("/s/2026_t.jsonl")).toBe(expected);
    expect(spillRootForTranscript("/s/2026_t.jsonl.gz")).toBe(expected);
    expect(spillRootForTranscript("/s/weird.txt")).toBe("");
  });
});

describe("transcriptSpillCapable", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "spill-header-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entry = (version: string): string =>
    `${JSON.stringify({ type: "model_change", id: "x", runtime: { version }, model: "p/m" })}\n`;

  it("reads a 19 transcript as spill-capable and an 18-only one as legacy", async () => {
    const v19 = path.join(dir, "v19.jsonl");
    await writeFile(v19, `{"type":"session","version":3}\n${entry("18.22.2")}${entry("19.0.0")}`);
    expect(await transcriptSpillCapable(v19)).toMatchObject({ version: "19.0.0", capable: true });
    const v18 = path.join(dir, "v18.jsonl");
    await writeFile(v18, `{"type":"session","version":3}\n${entry("18.22.2")}`);
    expect(await transcriptSpillCapable(v18)).toMatchObject({ version: "18.22.2", capable: false });
  });

  it("handles a gzipped archive and an unversioned transcript", async () => {
    const gz = path.join(dir, "a.jsonl.gz");
    await writeFile(gz, zlib.gzipSync(`{"type":"session"}\n${entry("18.22.0")}`));
    expect(await transcriptSpillCapable(gz)).toMatchObject({ version: "18.22.0", capable: false });
    const bare = path.join(dir, "bare.jsonl");
    await writeFile(bare, '{"type":"session"}\n');
    expect(await transcriptSpillCapable(bare)).toEqual({ version: null, capable: true });
    expect(await transcriptSpillCapable(path.join(dir, "gone.jsonl"))).toEqual({ version: null, capable: true });
  });
});

describe("readSpillFile", () => {
  let dir: string;
  let root: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "spill-read-"));
    root = path.join(dir, "local");
    await mkdir(root);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a plain spill whole", async () => {
    await writeFile(path.join(root, "0.log"), "line one\nline two");
    expect(await readSpillFile(root, 0)).toEqual({ status: "ok", text: "line one\nline two", truncated: false });
  });

  it("returns the capped head with a truncated flag past the bound", async () => {
    await writeFile(path.join(root, "1.log"), Buffer.alloc(SPILL_READ_MAX_BYTES + 7, 0x61));
    const result = await readSpillFile(root, 1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.text.length).toBe(SPILL_READ_MAX_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("treats a file ending exactly at the bound as complete", async () => {
    await writeFile(path.join(root, "2.log"), Buffer.alloc(SPILL_READ_MAX_BYTES, 0x62));
    const result = await readSpillFile(root, 2);
    expect(result).toMatchObject({ status: "ok", truncated: false });
  });

  it("reports missing files and non-regular targets as missing", async () => {
    expect(await readSpillFile(root, 404)).toEqual({ status: "missing" });
    await mkdir(path.join(root, "9.log"));
    expect(await readSpillFile(root, 9)).toEqual({ status: "missing" });
    expect(await readSpillFile(path.join(dir, "absent"), 0)).toEqual({ status: "missing" });
  });

  it("refuses a spill symlinked outside the root", async () => {
    const outside = path.join(dir, "outside.log");
    await writeFile(outside, "not yours");
    await symlink(outside, path.join(root, "3.log"));
    expect(await readSpillFile(root, 3)).toEqual({ status: "missing" });
  });

  it("accepts a final symlink that resolves inside the root", async () => {
    await writeFile(path.join(root, "4.log"), "real");
    await symlink(path.join(root, "4.log"), path.join(root, "8.log"));
    expect(await readSpillFile(root, 8)).toEqual({ status: "ok", text: "real", truncated: false });
  });

  it("rejects malformed ids outright", async () => {
    expect(await readSpillFile(root, -1)).toEqual({ status: "missing" });
    expect(await readSpillFile(root, 1.5)).toEqual({ status: "missing" });
  });
});
