// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

type TextScaleModule = typeof import("./text-scale");

const KEY = "omp-ui.transcriptScale";

/**
 * The module seeds its scale from localStorage at load, so each test needs a
 * fresh copy — dynamic import after `resetModules` is the only way to
 * re-exercise that load path (rule exception: module-loading boundary).
 */
async function freshModule(): Promise<TextScaleModule> {
  vi.resetModules();
  return import("./text-scale");
}

/**
 * Persisted state is the observable contract (it is what the next launch
 * reads), so assertions go through localStorage after a step.
 */
function persistedScale(): number {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? 1 : Number(raw);
}

describe("transcript text scale", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("steps up through the ladder and persists each step", async () => {
    const mod = await freshModule();
    mod.stepTranscriptScale(1);
    expect(persistedScale()).toBe(1.125);
    mod.stepTranscriptScale(1);
    expect(persistedScale()).toBe(1.25);
  });

  it("clamps at both ends instead of wrapping", async () => {
    const mod = await freshModule();
    for (let i = 0; i < 10; i++) mod.stepTranscriptScale(1);
    expect(persistedScale()).toBe(1.5);
    for (let i = 0; i < 10; i++) mod.stepTranscriptScale(-1);
    expect(persistedScale()).toBe(0.875);
  });

  it("reset returns to 1 and persists it", async () => {
    const mod = await freshModule();
    mod.stepTranscriptScale(1);
    mod.resetTranscriptScale();
    expect(persistedScale()).toBe(1);
  });

  it("ignores a corrupted persisted value and starts at 1", async () => {
    window.localStorage.setItem(KEY, "9000");
    const mod = await freshModule();
    // A single step from a corrupt seed lands on the step above 1, proving
    // the load snapped to a known value rather than trusting the garbage.
    mod.stepTranscriptScale(1);
    expect(persistedScale()).toBe(1.125);
  });

  it("resumes from a valid persisted step", async () => {
    window.localStorage.setItem(KEY, "1.25");
    const mod = await freshModule();
    mod.stepTranscriptScale(1);
    expect(persistedScale()).toBe(1.5);
  });
});
