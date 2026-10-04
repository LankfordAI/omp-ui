import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewOverlayPath, writeReviewOverlay } from "./review-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-review-overlay-test-"));
  dirs.push(dir);
  return dir;
}

describe("writeReviewOverlay", () => {
  it("restates the rpc defaults the launch depends on", () => {
    const dir = tempDir();
    const file = writeReviewOverlay(dir);
    expect(file).toBe(reviewOverlayPath(dir));
    expect(fs.readFileSync(file, "utf8")).toBe("async:\n  enabled: true\ntask:\n  batch: true\n");
  });

  it("is idempotent across spawns of the same lineage", () => {
    const dir = tempDir();
    writeReviewOverlay(dir);
    fs.writeFileSync(reviewOverlayPath(dir), "stale\n");
    const file = writeReviewOverlay(dir);
    expect(fs.readFileSync(file, "utf8")).toBe("async:\n  enabled: true\ntask:\n  batch: true\n");
  });
});
