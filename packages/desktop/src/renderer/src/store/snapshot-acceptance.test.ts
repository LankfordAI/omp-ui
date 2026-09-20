import { describe, expect, it } from "vitest";
import { isNewerSnapshot } from "./snapshot-acceptance";

const snapshot = (processKey: string, revision: number) => ({ processKey, revision });

describe("isNewerSnapshot", () => {
  it("accepts the first snapshot and every new process generation", () => {
    expect(isNewerSnapshot(null, snapshot("p1", 1))).toBe(true);
    expect(isNewerSnapshot(snapshot("p1", 9), snapshot("p2", 0))).toBe(true);
  });

  it("accepts only strictly newer revisions within one process", () => {
    expect(isNewerSnapshot(snapshot("p1", 4), snapshot("p1", 5))).toBe(true);
    expect(isNewerSnapshot(snapshot("p1", 4), snapshot("p1", 4))).toBe(false);
    expect(isNewerSnapshot(snapshot("p1", 4), snapshot("p1", 3))).toBe(false);
  });
});
