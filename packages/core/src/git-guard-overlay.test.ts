import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitGuardOverlayPath, writeGitGuardOverlay } from "./git-guard-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeGitGuardOverlay", () => {
  it("writes the bare-boolean guard pin and creates a missing lineage dir", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-git-guard-test-"));
    dirs.push(parent);
    const dir = path.join(parent, "lineage");
    const file = writeGitGuardOverlay(dir, true);
    expect(file).toBe(gitGuardOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe("bash:\n  gitGuard: true\n");
  });

  it("removes a pre-existing artifact on a null pin and returns null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-git-guard-test-"));
    dirs.push(dir);
    writeGitGuardOverlay(dir, true);
    expect(writeGitGuardOverlay(dir, null)).toBeNull();
    expect(fs.existsSync(gitGuardOverlayPath(dir))).toBe(false);
  });

  it("leaves no file when a pin is later cleared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-git-guard-test-"));
    dirs.push(dir);
    writeGitGuardOverlay(dir, true);
    writeGitGuardOverlay(dir, null);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("treats a false pin as removal, never an on-disk false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-git-guard-test-"));
    dirs.push(dir);
    writeGitGuardOverlay(dir, true);
    expect(writeGitGuardOverlay(dir, false)).toBeNull();
    expect(fs.existsSync(gitGuardOverlayPath(dir))).toBe(false);
  });
});
