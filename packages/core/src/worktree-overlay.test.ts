import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { worktreeOverlayPath, writeWorktreeOverlay } from "./worktree-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-worktree-overlay-"));
  dirs.push(dir);
  return dir;
}

describe("writeWorktreeOverlay", () => {
  it("creates a lineage overlay that pins omp's worktree keys off", () => {
    const lineageDir = path.join(tmp(), "lineage");
    const file = writeWorktreeOverlay(lineageDir);
    expect(file).toBe(path.join(lineageDir, "omp-ui-worktree.yml"));
    expect(worktreeOverlayPath(lineageDir)).toBe(file);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toBe("worktree:\n  onStart: off\n  onExit: keep\n");
    expect(yaml.load(text)).toEqual({ worktree: { onStart: "off", onExit: "keep" } });
  });

  it("rewrites a stale overlay enabling omp's worktree keys on every launch", () => {
    const lineageDir = tmp();
    const file = path.join(lineageDir, "omp-ui-worktree.yml");
    fs.writeFileSync(file, "worktree:\n  onStart: create\n  onExit: remove\n");
    expect(writeWorktreeOverlay(lineageDir)).toBe(file);
    expect(yaml.load(fs.readFileSync(file, "utf8"))).toEqual({
      worktree: { onStart: "off", onExit: "keep" },
    });
    expect(writeWorktreeOverlay(lineageDir)).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe("worktree:\n  onStart: off\n  onExit: keep\n");
  });
});
