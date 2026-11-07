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
  it("pins omp's worktree keys off and ovnfs.path at the lineage directory", () => {
    const lineageDir = path.join(tmp(), "lineage");
    const file = writeWorktreeOverlay(lineageDir);
    expect(file).toBe(path.join(lineageDir, "omp-ui-worktree.yml"));
    expect(worktreeOverlayPath(lineageDir)).toBe(file);
    // The pinned path is the lineage dir itself: no separate sentinel object
    // to create, reclaim, or keep in sync — the artifact writer's own
    // directory precondition is the non-executable guarantee, and a
    // directory is not an executable on any platform.
    expect(yaml.load(fs.readFileSync(file, "utf8"))).toEqual({
      worktree: { onStart: "off", onExit: "keep" },
      ovnfs: { path: path.resolve(lineageDir) },
    });
    // The same write created that directory (it holds this overlay), so the
    // pinned path exists as a directory by construction, for a fresh lineage.
    expect(fs.statSync(path.resolve(lineageDir)).isDirectory()).toBe(true);
  });

  it("rewrites a stale overlay on every launch, keeping all three pins", () => {
    const lineageDir = tmp();
    const file = path.join(lineageDir, "omp-ui-worktree.yml");
    fs.writeFileSync(file, "worktree:\n  onStart: create\n  onExit: remove\n");
    expect(writeWorktreeOverlay(lineageDir)).toBe(file);
    expect(yaml.load(fs.readFileSync(file, "utf8"))).toEqual({
      worktree: { onStart: "off", onExit: "keep" },
      ovnfs: { path: path.resolve(lineageDir) },
    });
    expect(writeWorktreeOverlay(lineageDir)).toBe(file);
    expect(yaml.load(fs.readFileSync(file, "utf8"))).toEqual({
      worktree: { onStart: "off", onExit: "keep" },
      ovnfs: { path: path.resolve(lineageDir) },
    });
  });
});
