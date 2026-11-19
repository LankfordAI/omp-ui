import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { intentTracingOverlayPath, writeIntentTracingOverlay } from "./intent-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-intent-test-"));
  dirs.push(dir);
  return dir;
}

describe("writeIntentTracingOverlay", () => {
  it("writes the pin and creates a missing lineage dir", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-intent-test-"));
    dirs.push(parent);
    const dir = path.join(parent, "lineage");
    const file = writeIntentTracingOverlay(dir, true);
    expect(file).toBe(intentTracingOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe("tools:\n  intentTracing: true\n");
  });

  it("removes a pre-existing artifact on a null pin and returns null", () => {
    const dir = tmp();
    writeIntentTracingOverlay(dir, true);
    expect(writeIntentTracingOverlay(dir, null)).toBeNull();
    expect(fs.existsSync(intentTracingOverlayPath(dir))).toBe(false);
  });

  it("treats a false pin as removal, never an on-disk false", () => {
    const dir = tmp();
    writeIntentTracingOverlay(dir, true);
    expect(writeIntentTracingOverlay(dir, false)).toBeNull();
    expect(fs.existsSync(intentTracingOverlayPath(dir))).toBe(false);
  });
});
