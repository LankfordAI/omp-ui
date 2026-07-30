import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  findNewestSessionFile,
  resolveSessionLocation,
  unarchiveSession,
} from "./archive";

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const FILE_NAME = `2026-07-29T16-18-42-427Z_${SESSION_ID}.jsonl`;
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const CONTENTS = '{"type":"session","version":3}\n';

const roots: { sessionsRoot: string; archiveRoot: string; base: string }[] = [];

function mkRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-arch-"));
  const sessionsRoot = path.join(base, "agent", "sessions");
  const archiveRoot = path.join(base, "agent", "archive", "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(archiveRoot, { recursive: true });
  roots.push({ sessionsRoot, archiveRoot, base });
  return { sessionsRoot, archiveRoot };
}

afterEach(() => {
  for (const { base } of roots.splice(0)) fs.rmSync(base, { recursive: true, force: true });
});

function writeActive(sessionsRoot: string, name = FILE_NAME, contents = CONTENTS): string {
  const dir = path.join(sessionsRoot, LINEAGE);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function writeArchived(archiveRoot: string, contents: Buffer | string = CONTENTS): string {
  const dir = path.join(archiveRoot, LINEAGE);
  fs.mkdirSync(dir, { recursive: true });
  const gz = path.join(dir, `${FILE_NAME}.gz`);
  const payload = typeof contents === "string" ? zlib.gzipSync(Buffer.from(contents)) : contents;
  fs.writeFileSync(gz, payload);
  return gz;
}

describe("resolveSessionLocation", () => {
  it("finds the exact active file by session id", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const file = writeActive(sessionsRoot);
    const loc = await resolveSessionLocation(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID);
    expect(loc).toEqual({ where: "active", filePath: file });
  });

  it("finds the exact archived gz by session id", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const gz = writeArchived(archiveRoot);
    const loc = await resolveSessionLocation(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID);
    expect(loc).toEqual({ where: "archived", filePath: gz });
  });

  it("adopts the newest active file when the id is stale or absent", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const file = writeActive(sessionsRoot);
    for (const id of ["stale-id", null]) {
      const loc = await resolveSessionLocation(sessionsRoot, archiveRoot, LINEAGE, id);
      expect(loc).toEqual({ where: "active", filePath: file });
    }
  });

  it("falls back to the newest archived file when nothing is active", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const gz = writeArchived(archiveRoot);
    const loc = await resolveSessionLocation(sessionsRoot, archiveRoot, LINEAGE, null);
    expect(loc).toEqual({ where: "archived", filePath: gz });
  });

  it("reports missing when neither side has anything", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const loc = await resolveSessionLocation(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID);
    expect(loc).toEqual({ where: "missing" });
  });
});

describe("findNewestSessionFile", () => {
  it("picks the newest .jsonl by mtime, ignoring .bak and the draft marker", async () => {
    const { sessionsRoot } = mkRoots();
    const dir = path.join(sessionsRoot, LINEAGE);
    const older = writeActive(sessionsRoot, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
    const newer = writeActive(sessionsRoot, FILE_NAME);
    fs.writeFileSync(`${older}.123.bak`, "orphan");
    fs.writeFileSync(path.join(dir, ".draft-only-session"), "");
    const past = new Date("2026-01-02T00:00:00Z");
    const now = new Date("2026-07-01T00:00:00Z");
    fs.utimesSync(older, past, past);
    fs.utimesSync(newer, now, now);
    fs.utimesSync(`${older}.123.bak`, new Date("2026-12-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"));

    expect(await findNewestSessionFile(dir)).toBe(newer);
  });

  it("returns null for a missing dir", async () => {
    const { sessionsRoot } = mkRoots();
    expect(await findNewestSessionFile(path.join(sessionsRoot, "nope"))).toBeNull();
  });
});

describe("unarchiveSession", () => {
  it("restores the .jsonl, removes the gz, and moves artifacts back", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const gz = writeArchived(archiveRoot);
    const name = path.basename(gz, ".jsonl.gz");
    const archivedArtifacts = path.join(archiveRoot, LINEAGE, name);
    fs.mkdirSync(archivedArtifacts, { recursive: true });
    fs.writeFileSync(path.join(archivedArtifacts, "__advisor.jsonl"), "advisor");

    const restored = await unarchiveSession(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID);

    expect(restored).toBe(path.join(sessionsRoot, LINEAGE, FILE_NAME));
    expect(fs.readFileSync(restored, "utf8")).toBe(CONTENTS);
    expect(fs.existsSync(gz)).toBe(false);
    expect(
      fs.readFileSync(path.join(sessionsRoot, LINEAGE, name, "__advisor.jsonl"), "utf8"),
    ).toBe("advisor");
    expect(fs.existsSync(archivedArtifacts)).toBe(false);
  });

  it("restores without an artifacts dir", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    writeArchived(archiveRoot);
    const restored = await unarchiveSession(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID);
    expect(fs.readFileSync(restored, "utf8")).toBe(CONTENTS);
  });

  it("throws on a corrupt gz and leaves the archive in place", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    const gz = writeArchived(archiveRoot, Buffer.from("not gzip data"));
    await expect(
      unarchiveSession(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID),
    ).rejects.toThrow(/corrupt gzip/);
    expect(fs.existsSync(gz)).toBe(true);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, FILE_NAME))).toBe(false);
  });

  it("throws when the archived file is missing", async () => {
    const { sessionsRoot, archiveRoot } = mkRoots();
    await expect(
      unarchiveSession(sessionsRoot, archiveRoot, LINEAGE, SESSION_ID),
    ).rejects.toThrow(/not found/);
  });
});
