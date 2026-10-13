import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateOverlayPath, writePrivateOverlay } from "./private-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-private-test-"));
  dirs.push(dir);
  return dir;
}

describe("writePrivateOverlay", () => {
  it("pins both passive write channels and creates a missing lineage dir", () => {
    const dir = path.join(tempDir(), "lineage");
    const file = writePrivateOverlay(dir, true);
    expect(file).toBe(privateOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe(
      "autolearn:\n  enabled: false\nmnemopi:\n  autoRetain: false\n",
    );
  });

  it("never names the recall switches — absence is what keeps recall alive", () => {
    const source = fs.readFileSync(writePrivateOverlay(tempDir(), true)!, "utf8");
    expect(source).not.toContain("autoRecall");
    expect(source).not.toContain("memory.backend");
    expect(source).not.toContain("backend");
  });

  it("lands exactly one artifact across repeated rewrites", () => {
    const dir = tempDir();
    writePrivateOverlay(dir, true);
    writePrivateOverlay(dir, true);
    expect(fs.readdirSync(dir)).toEqual(["omp-ui-private.yml"]);
  });

  it("removes a stale artifact on a false pin and returns null", () => {
    const dir = tempDir();
    writePrivateOverlay(dir, true);
    expect(writePrivateOverlay(dir, false)).toBeNull();
    expect(fs.existsSync(privateOverlayPath(dir))).toBe(false);
  });

  it("leaves no file when a pin is later cleared", () => {
    const dir = tempDir();
    writePrivateOverlay(dir, true);
    writePrivateOverlay(dir, false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
