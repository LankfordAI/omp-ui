import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ARTIFACT_LIMITS, ArtifactError } from "@omp-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArtifactDatasetFile, resolveArtifactLocalRoot } from "./artifact-dataset-file";

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const OTHER_ID = "019faeab-cc7b-7000-8bfc-000000000000";
const STEM = `2026-11-09T00-00-00-000Z_${SESSION_ID}`;
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

/** A real lineage (and archive lineage) with the session's transcript and `local` dir. */
function layout(where: "active" | "archive" = "active", stem = STEM) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omp-ui-dataset-file-"));
  dirs.push(base);
  const lineageDir = path.join(base, "sessions", "lineage");
  const archiveLineageDir = path.join(base, "archive", "lineage");
  fs.mkdirSync(lineageDir, { recursive: true });
  fs.mkdirSync(archiveLineageDir, { recursive: true });
  const owner = where === "active" ? lineageDir : archiveLineageDir;
  const transcriptPath = path.join(owner, `${stem}${where === "active" ? ".jsonl" : ".jsonl.gz"}`);
  fs.writeFileSync(transcriptPath, "{}\n");
  const local = path.join(owner, stem, "local");
  fs.mkdirSync(local, { recursive: true });
  return { base, lineageDir, archiveLineageDir, transcriptPath, local, request: { transcriptPath, sessionId: SESSION_ID, lineageDir, archiveLineageDir } };
}

const context = () => ({ signal: new AbortController().signal, authorize: () => {} });

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ArtifactError);
  return (error as ArtifactError).code;
}

describe("resolveArtifactLocalRoot", () => {
  it("returns the active and archived session local directories", async () => {
    const active = layout("active");
    await expect(resolveArtifactLocalRoot(active.request)).resolves.toBe(active.local);
    const archived = layout("archive");
    await expect(resolveArtifactLocalRoot(archived.request)).resolves.toBe(archived.local);
  });

  it("refuses unknown identity, mismatched or fallback transcripts and foreign lineages", async () => {
    const fixture = layout();
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, transcriptPath: null }))).toBe("source-missing");
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, sessionId: null }))).toBe("source-missing");
    // A newest-file fallback names another session's transcript.
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, sessionId: OTHER_ID }))).toBe("source-missing");
    const bare = path.join(fixture.lineageDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(bare, "{}\n");
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, transcriptPath: bare }))).toBe("source-missing");
    const other = layout();
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, transcriptPath: other.transcriptPath }))).toBe("source-missing");
    // Archived names belong to the archive lineage only.
    const gz = path.join(fixture.lineageDir, `${STEM}.jsonl.gz`);
    fs.writeFileSync(gz, "");
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, transcriptPath: gz }))).toBe("source-missing");
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, transcriptPath: gz, archiveLineageDir: undefined }))).toBe("source-missing");
    const other2 = path.join(fixture.lineageDir, `${STEM}.json`);
    fs.writeFileSync(other2, "");
    expect(await code(resolveArtifactLocalRoot({ ...fixture.request, transcriptPath: other2 }))).toBe("source-missing");
  });

  it("refuses a symlinked transcript, artifact directory or local directory, and never creates them", async () => {
    const fixture = layout();
    const sibling = layout();
    const artifactDir = path.dirname(fixture.local);
    fs.rmSync(fixture.local, { recursive: true });
    expect(await code(resolveArtifactLocalRoot(fixture.request))).toBe("source-missing");
    expect(fs.existsSync(fixture.local)).toBe(false);
    fs.symlinkSync(sibling.local, fixture.local);
    expect(await code(resolveArtifactLocalRoot(fixture.request))).toBe("unsupported-contract");
    fs.rmSync(artifactDir, { recursive: true });
    fs.symlinkSync(path.dirname(sibling.local), artifactDir);
    expect(await code(resolveArtifactLocalRoot(fixture.request))).toBe("unsupported-contract");
    const linked = layout();
    fs.rmSync(linked.transcriptPath);
    fs.symlinkSync(sibling.transcriptPath, linked.transcriptPath);
    expect(await code(resolveArtifactLocalRoot(linked.request))).toBe("source-missing");
  });
});

describe("readArtifactDatasetFile", () => {
  it("reads nested files and in-root symlinks as validated JSON", async () => {
    const { local } = layout();
    fs.mkdirSync(path.join(local, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(local, "a", "b", "rows.json"), JSON.stringify({ rows: [1, "é", null] }));
    await expect(readArtifactDatasetFile(local, "local://a/b/rows.json", context())).resolves.toEqual({ rows: [1, "é", null] });
    fs.symlinkSync(path.join(local, "a", "b", "rows.json"), path.join(local, "link.json"));
    await expect(readArtifactDatasetFile(local, "local://link.json", context())).resolves.toEqual({ rows: [1, "é", null] });
    fs.writeFileSync(path.join(local, "null.json"), "null");
    await expect(readArtifactDatasetFile(local, "local://null.json", context())).resolves.toBeNull();
  });

  it.each(["local://", "local:///abs.json", "local://C:/x.json", "local://a/../x.json", "local://./x.json", "local://a//x.json",
    "local://a\\x.json", "local://x.json?q", "local://x.json#f", "local://x\0.json", "file:///x.json", "x.json"])("rejects syntax %s", async (valueFile) => {
    const { local } = layout();
    expect(await code(readArtifactDatasetFile(local, valueFile, context()))).toBe("unsupported-contract");
  });

  it("refuses symlink escapes including sibling session files", async () => {
    const fixture = layout();
    const sibling = layout();
    fs.writeFileSync(path.join(sibling.local, "data.json"), "[1]");
    fs.writeFileSync(path.join(fixture.base, "outside.json"), "[1]");
    fs.symlinkSync(path.join(sibling.local, "data.json"), path.join(fixture.local, "sibling.json"));
    fs.symlinkSync(path.join(fixture.base, "outside.json"), path.join(fixture.local, "outside.json"));
    fs.symlinkSync(sibling.local, path.join(fixture.local, "dir"));
    fs.symlinkSync(fixture.local, path.join(fixture.local, "self"));
    for (const valueFile of ["local://sibling.json", "local://outside.json", "local://dir/data.json"]) {
      expect(await code(readArtifactDatasetFile(fixture.local, valueFile, context()))).toBe("unsupported-contract");
    }
    // The root itself is not a dataset file.
    expect(await code(readArtifactDatasetFile(fixture.local, "local://self", context()))).toBe("unsupported-contract");
    expect(await code(readArtifactDatasetFile(fixture.local, "local://absent.json", context()))).toBe("source-missing");
  });

  it("refuses directories and FIFOs without opening them", async () => {
    const { local } = layout();
    fs.mkdirSync(path.join(local, "dir"));
    expect(await code(readArtifactDatasetFile(local, "local://dir", context()))).toBe("unsupported-contract");
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path.join(local, "pipe")]);
      const open = vi.spyOn(fs.promises, "open");
      expect(await code(readArtifactDatasetFile(local, "local://pipe", context()))).toBe("unsupported-contract");
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed JSON, invalid UTF-8, a BOM and invalid JSON values without echoing contents", async () => {
    const { local } = layout();
    fs.writeFileSync(path.join(local, "bad.json"), "{secret-token");
    fs.writeFileSync(path.join(local, "utf.json"), Buffer.from([0x22, 0xff, 0x22]));
    fs.writeFileSync(path.join(local, "bom.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("[]")]));
    fs.writeFileSync(path.join(local, "deep.json"), "[".repeat(80) + "]".repeat(80));
    for (const name of ["bad.json", "utf.json", "bom.json", "deep.json"]) {
      const error = await readArtifactDatasetFile(local, `local://${name}`, context()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ArtifactError);
      expect((error as Error).message).toContain(`local://${name}`);
      expect((error as Error).message).not.toContain("secret-token");
    }
  });

  it("accepts exactly the raw byte limit and refuses one more byte", async () => {
    const { local } = layout();
    const limit = ARTIFACT_LIMITS.datasetBytes;
    fs.writeFileSync(path.join(local, "exact.json"), `"${"a".repeat(limit - 2)}"`);
    const value = await readArtifactDatasetFile(local, "local://exact.json", context());
    expect(typeof value === "string" && value.length).toBe(limit - 2);
    fs.writeFileSync(path.join(local, "over.json"), `"${"a".repeat(limit - 1)}"`);
    expect(await code(readArtifactDatasetFile(local, "local://over.json", context()))).toBe("over-limit");
    // Whitespace counts toward the raw file limit even when the value is small.
    fs.writeFileSync(path.join(local, "padded.json"), `${" ".repeat(limit)}1`);
    expect(await code(readArtifactDatasetFile(local, "local://padded.json", context()))).toBe("over-limit");
  });

  /** Runs `during` inside the first read of the open descriptor. */
  function duringFirstRead(during: () => void): void {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<fs.promises.FileReadResult<Buffer>>;
      let first = true;
      vi.spyOn(handle, "read").mockImplementation((async (...readArgs: unknown[]) => {
        if (first) { first = false; during(); }
        return read(...readArgs);
      }) as never);
      return handle;
    });
  }

  it("detects growth during the read", async () => {
    const { local } = layout();
    const file = path.join(local, "grow.json");
    fs.writeFileSync(file, "[1]");
    duringFirstRead(() => fs.appendFileSync(file, "    "));
    expect(await code(readArtifactDatasetFile(local, "local://grow.json", context()))).toBe("conflict");
  });

  it("detects truncation, replacement and swapped roots during the read", async () => {
    const shrink = layout();
    const shrunk = path.join(shrink.local, "shrink.json");
    fs.writeFileSync(shrunk, "[1,2,3]");
    duringFirstRead(() => fs.truncateSync(shrunk, 2));
    expect(await code(readArtifactDatasetFile(shrink.local, "local://shrink.json", context()))).toBe("conflict");
    vi.restoreAllMocks();

    const replaced = layout();
    const file = path.join(replaced.local, "data.json");
    fs.writeFileSync(file, "[1]");
    duringFirstRead(() => { fs.writeFileSync(`${file}.new`, "[2]"); fs.renameSync(`${file}.new`, file); });
    expect(await code(readArtifactDatasetFile(replaced.local, "local://data.json", context()))).toBe("conflict");
    vi.restoreAllMocks();

    const swapped = layout();
    const sibling = layout();
    fs.writeFileSync(path.join(swapped.local, "data.json"), "[1]");
    fs.writeFileSync(path.join(sibling.local, "data.json"), "[1]");
    duringFirstRead(() => { fs.renameSync(swapped.local, `${swapped.local}.old`); fs.symlinkSync(sibling.local, swapped.local); });
    expect(await code(readArtifactDatasetFile(swapped.local, "local://data.json", context()))).toBe("conflict");
    vi.restoreAllMocks();

    const moved = layout();
    const movedDir = path.dirname(moved.local);
    fs.writeFileSync(path.join(moved.local, "data.json"), "[1]");
    duringFirstRead(() => { fs.renameSync(movedDir, `${movedDir}.old`); fs.mkdirSync(moved.local, { recursive: true }); fs.writeFileSync(path.join(moved.local, "data.json"), "[1]"); });
    expect(await code(readArtifactDatasetFile(moved.local, "local://data.json", context()))).toBe("conflict");
  });

  it("closes the descriptor and stops on abort or revoked authority", async () => {
    const { local } = layout();
    fs.writeFileSync(path.join(local, "data.json"), "[1]");
    const controller = new AbortController();
    controller.abort();
    await expect(readArtifactDatasetFile(local, "local://data.json", { signal: controller.signal, authorize: () => {} })).rejects.toThrow();

    const closes: number[] = [];
    let opened = false;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      opened = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { closes.push(1); await close(); });
      return handle;
    });
    let calls = 0;
    const revokeAfterOpen = () => { calls++; if (opened) throw new ArtifactError("disabled", "revoked"); };
    expect(await code(readArtifactDatasetFile(local, "local://data.json", { signal: new AbortController().signal, authorize: revokeAfterOpen }))).toBe("disabled");
    expect(calls).toBeGreaterThan(0);
    expect(closes).toEqual([1]);
  });
});
