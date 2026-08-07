import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fitWindowBounds,
  loadWindowState,
  saveWindowState,
  windowStatePath,
} from "./window-state";

const validState = {
  schemaVersion: 1 as const,
  bounds: { x: 10, y: 20, width: 1200, height: 800 },
  maximized: true,
};

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

describe("window-state", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-ui-window-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through a temp dir with no tmp file left behind", () => {
    const file = windowStatePath(dir);
    expect(saveWindowState(file, validState)).toBe(true);
    expect(loadWindowState(file)).toEqual(validState);
    expect(readdirSync(dir)).toEqual(["window-state.json"]);
  });

  it("returns null for malformed JSON", () => {
    const file = windowStatePath(dir);
    writeFileSync(file, "not json", "utf8");
    expect(loadWindowState(file)).toBeNull();
  });

  it("returns null for an unknown schemaVersion", () => {
    const file = windowStatePath(dir);
    writeFileSync(
      file,
      JSON.stringify({ ...validState, schemaVersion: 2 }),
      "utf8",
    );
    expect(loadWindowState(file)).toBeNull();
  });

  it("returns null when the window is smaller than 100x100", () => {
    const file = windowStatePath(dir);
    writeFileSync(
      file,
      JSON.stringify({
        ...validState,
        bounds: { ...validState.bounds, width: 50 },
      }),
      "utf8",
    );
    expect(loadWindowState(file)).toBeNull();
  });

  it("returns null when a bound is non-finite", () => {
    const file = windowStatePath(dir);
    // `1e999` parses to Infinity (JSON.stringify would emit `null` instead,
    // which the typeof check alone could reject — this exercises isFinite).
    writeFileSync(
      file,
      `{"schemaVersion":1,"bounds":{"x":1e999,"y":20,"width":1200,"height":800},"maximized":true}`,
      "utf8",
    );
    expect(loadWindowState(file)).toBeNull();
  });

  it("returns null for a missing file without throwing", () => {
    expect(loadWindowState(windowStatePath(dir))).toBeNull();
  });

  it("returns false on write failure and cleans up the tmp file", () => {
    // A directory at `file` makes renameSync(tmp, file) fail (EISDIR/ENOTEMPTY).
    const file = windowStatePath(dir);
    mkdirSync(file);
    expect(saveWindowState(file, validState)).toBe(false);
    // Only the directory remains: the failed .tmp- file was removed.
    expect(readdirSync(dir)).toEqual(["window-state.json"]);
  });

  it("clamps oversized bounds to the work area", () => {
    expect(
      fitWindowBounds({ x: -500, y: -500, width: 3000, height: 2000 }, workArea),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("clamps off-screen bounds so 100x100 stays visible", () => {
    expect(
      fitWindowBounds({ x: 2000, y: 1500, width: 300, height: 200 }, workArea),
    ).toEqual({ x: 1820, y: 980, width: 300, height: 200 });
  });

  it("returns null for an invalid work area", () => {
    expect(fitWindowBounds(validState.bounds, { ...workArea, width: Infinity })).toBeNull();
    expect(fitWindowBounds(validState.bounds, { ...workArea, width: 50 })).toBeNull();
  });
});