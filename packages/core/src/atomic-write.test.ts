import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTextAtomic, writeTextDurably } from "./atomic-write";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-atomic-write-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Windows has no POSIX mode bits to assert on.
const posixOnly = it.skipIf(process.platform === "win32");

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("writeTextDurably", () => {
  it("creates missing parent directories and leaves no temp file behind", () => {
    const dir = mkTmp();
    const file = path.join(dir, "a", "b", "state.json");
    writeTextDurably(file, "{\"v\":1}");
    expect(fs.readFileSync(file, "utf8")).toBe("{\"v\":1}");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["state.json"]);
  });

  posixOnly("a new file is private (0o600) unless a mode is given", () => {
    const dir = mkTmp();
    const secret = path.join(dir, "secret.json");
    const shared = path.join(dir, "shared.json");
    writeTextDurably(secret, "s");
    writeTextDurably(shared, "s", 0o644);
    expect(modeOf(secret)).toBe(0o600);
    expect(modeOf(shared)).toBe(0o644);
  });

  posixOnly("replacing an existing file keeps its mode", () => {
    const dir = mkTmp();
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeTextDurably(file, "new");
    expect(modeOf(file)).toBe(0o644);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });

  it("replaces the whole content, including shrinking it", () => {
    const dir = mkTmp();
    const file = path.join(dir, "log.txt");
    writeTextDurably(file, "a much longer first version");
    writeTextDurably(file, "short");
    expect(fs.readFileSync(file, "utf8")).toBe("short");
  });

  it("removes the temp file and propagates the error when the rename fails", () => {
    const dir = mkTmp();
    const file = path.join(dir, "taken");
    fs.mkdirSync(file);
    expect(() => writeTextDurably(file, "x")).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["taken"]);
    expect(fs.readdirSync(file)).toEqual([]);
  });
});

describe("writeTextAtomic", () => {
  it("replaces the content through a same-directory temp", () => {
    const dir = mkTmp();
    const file = path.join(dir, "state.json");
    writeTextAtomic(file, "one");
    writeTextAtomic(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });
});
