import { describe, expect, it } from "vitest";
import {
  RECOVERY_MAX_RELOADS,
  RECOVERY_WINDOW_MS,
  shouldReloadRenderer,
  type ProcessDeath,
} from "./renderer-recovery";

const death = (at: number, reason = "crashed"): ProcessDeath => ({ at, reason });

describe("shouldReloadRenderer (issue #183)", () => {
  it("never reloads a clean exit", () => {
    expect(shouldReloadRenderer("clean-exit", [], 1_000)).toBe(false);
  });

  it("reloads deaths inside the window up to the cap", () => {
    const history = [death(0), death(10_000)];
    expect(shouldReloadRenderer("crashed", history, 20_000)).toBe(true);
  });

  it("gives up once the window already holds the max reloads", () => {
    const history = Array.from({ length: RECOVERY_MAX_RELOADS }, (_, i) => death(i * 1_000));
    expect(shouldReloadRenderer("crashed", history, 10_000)).toBe(false);
  });

  it("forgets deaths outside the window", () => {
    const history = Array.from({ length: RECOVERY_MAX_RELOADS }, (_, i) => death(i * 1_000));
    expect(shouldReloadRenderer("crashed", history, RECOVERY_WINDOW_MS + 10_000)).toBe(true);
  });

  it("reloads an oom death", () => {
    expect(shouldReloadRenderer("oom", [], 0)).toBe(true);
  });
});
