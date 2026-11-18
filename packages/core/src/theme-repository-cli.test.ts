import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runThemeRepositoryCli } from "./theme-repository-cli";
import { parseThemeIndex, parseThemeIndexV2, themeDetailsFile } from "./theme-repository-format";

const themeText = (label: string, canvas: string): string =>
  JSON.stringify({ format: "omp-ui-theme", version: 1, label, seeds: { canvas } });

/** Writes a valid two-theme repository under a fresh temp dir; returns its path. */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omp-ui-theme-cli-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "themes"), { recursive: true });
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(dir, ".git"), { recursive: true });
  const files: Record<string, string> = {
    "README.md": "# themes\n",
    "tags.json": JSON.stringify({
      format: "omp-ui-theme-tags",
      version: 1,
      tags: [{ id: "cool", description: "Blues lead." }],
    }),
    "featured.json": JSON.stringify({ format: "omp-ui-theme-featured", version: 1, paths: ["themes/dusk.json"] }),
    ".github/workflows/check.yml": "on: pull_request\n",
    ".git/config": "[core]\n",
    "themes/dusk.json": themeText("Dusk", "#1a1b26"),
    "themes/dusk.details.json": themeDetailsFile({ tags: ["cool"], description: "A theme.", author: null }),
    "themes/night.json": themeText("Night", "#101010"),
    "themes/night.details.json": themeDetailsFile({ tags: ["cool"], description: "Another theme.", author: null }),
  };
  for (const [relative, text] of Object.entries(files)) await writeFile(path.join(dir, relative), text);
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const io = (): { code: string[]; errors: string[]; out: (line: string) => void; err: (line: string) => void } => {
  const code: string[] = [];
  const errors: string[] = [];
  return { code, errors, out: (line) => code.push(line), err: (line) => errors.push(line) };
};

describe("runThemeRepositoryCli", () => {
  it("refuses bad arguments with usage and exit 2", async () => {
    const log = io();
    expect(await runThemeRepositoryCli([], log)).toBe(2);
    expect(await runThemeRepositoryCli(["check"], log)).toBe(2);
    expect(await runThemeRepositoryCli(["lint", "/tmp", "extra"], log)).toBe(2);
    expect(log.errors).toEqual(Array.from({ length: 3 }, () => "usage: omp-ui-theme-tool <check|generate> <repository-dir>"));
  });

  it("check passes a valid repository and ignores the .git directory", async () => {
    const dir = await fixture();
    const log = io();
    expect(await runThemeRepositoryCli(["check", dir], log)).toBe(0);
    expect(log.errors).toEqual([]);
    expect(log.code).toEqual(["2 themes, 0 errors"]);
  });

  it("check exits 1 and names the offending path", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "themes", "night.json"), themeText("dusk", "#101010"));
    const log = io();
    expect(await runThemeRepositoryCli(["check", dir], log)).toBe(1);
    expect(log.errors).toContainEqual(expect.stringMatching(/^themes\/night\.json: the label "dusk" is already used/));
  });

  it("generate writes both indexes and reports their entry counts", async () => {
    const dir = await fixture();
    const log = io();
    expect(await runThemeRepositoryCli(["generate", dir], log)).toBe(0);
    const v1 = parseThemeIndex(await readFile(path.join(dir, "omp-ui-themes.json"), "utf8"));
    const v2 = parseThemeIndexV2(await readFile(path.join(dir, "omp-ui-themes.v2.json"), "utf8"));
    expect(v1.ok && v1.entries.map((entry) => entry.path)).toEqual(["themes/dusk.json", "themes/night.json"]);
    expect(v2.ok && v2.entries.map((entry) => [entry.path, entry.meta.featured])).toEqual([
      ["themes/dusk.json", true],
      ["themes/night.json", false],
    ]);
    const today = new Date().toISOString().slice(0, 10);
    expect(v2.ok && v2.entries.every((entry) => entry.meta.added === today)).toBe(true);
    expect(log.code).toContain("omp-ui-themes.json: 2 themes");
    expect(log.code).toContain("omp-ui-themes.v2.json: 2 themes");
  });

  it("generate keeps the committed added dates on a second run", async () => {
    const dir = await fixture();
    expect(await runThemeRepositoryCli(["generate", dir], io())).toBe(0);
    const first = await readFile(path.join(dir, "omp-ui-themes.v2.json"), "utf8");
    // A month in the future does not redate themes that already have a date.
    const log = io();
    expect(await runThemeRepositoryCli(["generate", dir], log)).toBe(0);
    expect(await readFile(path.join(dir, "omp-ui-themes.v2.json"), "utf8")).toBe(first);
  });

  it("generate refuses a repository that does not check", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "themes", "orphan.details.json"), themeDetailsFile({ tags: ["cool"], description: "No theme file.", author: null }));
    const log = io();
    expect(await runThemeRepositoryCli(["generate", dir], log)).toBe(1);
    expect(log.errors.some((line) => line.includes("themes/orphan.details.json: has no theme file"))).toBe(true);
  });
});
