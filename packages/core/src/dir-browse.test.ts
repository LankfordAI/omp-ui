import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browseDirectories, expandHomePath, resolveProjectPath } from "./dir-browse";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-browse-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    // A chmod-0 fixture must be reopened before rm can traverse it.
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("expandHomePath", () => {
  it("expands ~ to home", () => {
    expect(expandHomePath("~", "/home/u")).toBe("/home/u");
  });

  it("expands ~/x under home", () => {
    expect(expandHomePath("~/x", "/home/u")).toBe(path.join("/home/u", "x"));
  });

  it("leaves absolute and plain paths unchanged", () => {
    expect(expandHomePath("/abs/p", "/home/u")).toBe("/abs/p");
    expect(expandHomePath("plain", "/home/u")).toBe("plain");
  });
});

describe("browseDirectories", () => {
  it("lists only directories, sorted, in trailing-separator mode", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "beta"));
    fs.mkdirSync(path.join(dir, "alpha"));
    fs.writeFileSync(path.join(dir, "file.txt"), "");

    const r = await browseDirectories(`${dir}/`);
    expect(r.error).toBeNull();
    expect(r.parentPath).toBe(dir);
    expect(r.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  });

  it("filters the leaf case-insensitively and joins fullPath under parentPath", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "alpha"));
    fs.mkdirSync(path.join(dir, "other"));

    const r = await browseDirectories(path.join(dir, "Alp"));
    expect(r.parentPath).toBe(dir);
    expect(r.entries).toEqual([{ name: "alpha", fullPath: path.join(dir, "alpha") }]);
  });

  it("expands ~ against opts.home", async () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, "proj"));

    const r = await browseDirectories("~/", { home });
    expect(r.parentPath).toBe(home);
    expect(r.entries.map((e) => e.name)).toEqual(["proj"]);
  });

  it("hides dot-directories unless the leaf prefix starts with .", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.mkdirSync(path.join(dir, "visible"));

    const listing = await browseDirectories(`${dir}/`);
    expect(listing.entries.map((e) => e.name)).toEqual(["visible"]);

    const dotted = await browseDirectories(path.join(dir, ".h"));
    expect(dotted.entries.map((e) => e.name)).toEqual([".hidden"]);
  });

  it("returns 'missing' for a nonexistent directory", async () => {
    const r = await browseDirectories("/definitely/not/a/real/dir/");
    expect(r.error).toBe("missing");
    expect(r.entries).toEqual([]);
  });

  it.runIf(process.getuid?.() !== 0)("returns 'denied' for an unreadable directory", async () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o000);

    const r = await browseDirectories(`${dir}/`);
    expect(r.error).toBe("denied");
    expect(r.entries).toEqual([]);
  });

  it("rejects relative input as 'invalid'", async () => {
    for (const input of ["foo", "./foo", ""]) {
      const r = await browseDirectories(input);
      expect(r).toEqual({ parentPath: "", entries: [], error: "invalid" });
    }
  });
});

describe("resolveProjectPath", () => {
  it("resolves a ~-path to an absolute directory", async () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, "proj"));
    await expect(resolveProjectPath("~/proj", { home })).resolves.toBe(path.join(home, "proj"));
  });

  it("throws on a nonexistent directory", async () => {
    await expect(resolveProjectPath("/definitely/not/a/real/dir")).rejects.toThrow(
      /no such directory/,
    );
  });

  it("throws on a file path", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "");
    await expect(resolveProjectPath(file)).rejects.toThrow(/not a directory/);
  });

  it("throws on relative input", async () => {
    await expect(resolveProjectPath("rel")).rejects.toThrow(/must start with/);
  });
});
