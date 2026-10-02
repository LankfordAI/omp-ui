import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  goalOverlayPath,
  rpcGoalContinuationModes,
  writeGoalContinuationOverlay,
} from "./goal-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-goal-overlay-test-"));
  dirs.push(dir);
  return dir;
}

describe("rpcGoalContinuationModes", () => {
  it("adds rpc only when the user keeps interactive and lacks rpc", () => {
    expect(rpcGoalContinuationModes([])).toBeNull();
    expect(rpcGoalContinuationModes(["interactive"])).toEqual(["interactive", "rpc"]);
    expect(rpcGoalContinuationModes(["interactive", "rpc"])).toBeNull();
    expect(rpcGoalContinuationModes(["rpc"])).toBeNull();
  });
});

describe("writeGoalContinuationOverlay", () => {
  it("writes the modes as a quoted YAML list", () => {
    const dir = tempDir();
    const file = writeGoalContinuationOverlay(dir, ["interactive", "rpc"]);
    expect(file).toBe(goalOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe(
      'goal:\n  continuationModes:\n    - "interactive"\n    - "rpc"\n',
    );
  });

  it("removes a stale overlay and returns null", () => {
    const dir = tempDir();
    writeGoalContinuationOverlay(dir, ["interactive", "rpc"]);
    expect(writeGoalContinuationOverlay(dir, null)).toBeNull();
    expect(fs.existsSync(goalOverlayPath(dir))).toBe(false);
  });
});
