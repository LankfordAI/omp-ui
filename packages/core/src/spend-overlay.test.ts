import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spendOverlayPath, writeSpendOverlay } from "./spend-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeSpendOverlay (U7)", () => {
  it("writes session.warnCost and session.maxCost when positive", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spend-test-"));
    dirs.push(dir);
    const file = writeSpendOverlay(dir, 2, 5);
    expect(file).toBe(spendOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe("session:\n  warnCost: 2\n  maxCost: 5\n");
  });

  it("omits zero slots while keeping positive ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spend-test-"));
    dirs.push(dir);
    expect(writeSpendOverlay(dir, 0, 5)).toBe(spendOverlayPath(dir));
    expect(fs.readFileSync(spendOverlayPath(dir), "utf8")).toBe("session:\n  maxCost: 5\n");

    expect(writeSpendOverlay(dir, 1.5, 0)).toBe(spendOverlayPath(dir));
    expect(fs.readFileSync(spendOverlayPath(dir), "utf8")).toBe("session:\n  warnCost: 1.5\n");
  });

  it("removes any stale file and returns null when both caps are 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spend-test-"));
    dirs.push(dir);
    writeSpendOverlay(dir, 2, 5);
    expect(fs.existsSync(spendOverlayPath(dir))).toBe(true);
    expect(writeSpendOverlay(dir, 0, 0)).toBeNull();
    expect(fs.existsSync(spendOverlayPath(dir))).toBe(false);
  });
});
