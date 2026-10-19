import { describe, expect, it } from "vitest";
import { keywordsIn } from "@omp-ui/core/magic-keywords";
import { seanceKickoff, type SeanceKickoffSpec } from "./seance-kickoff";

const spec = (patch: Partial<SeanceKickoffSpec> = {}): SeanceKickoffSpec => ({
  sourceSession: "/home/u/.omp/agent/sessions/omp-ui--proj--abc/2026_x.jsonl",
  sourceLabel: "Deadlock investigation",
  question: "Why did the retry loop stall?",
  ...patch,
});

describe("seanceKickoff (issue #885)", () => {
  it("names the single task call with agent, path, and the relay contract", () => {
    const text = seanceKickoff(spec());
    expect(text).toContain('agent: "seance"');
    expect(text).toContain(
      'sourceSession: "/home/u/.omp/agent/sessions/omp-ui--proj--abc/2026_x.jsonl"',
    );
    // A clean question rides verbatim; a keyword-bearing one gets fenced below.
    expect(text).toContain("\nWhy did the retry loop stall?\n");
    expect(text).toContain("never resumed or modified");
    expect(text).toContain("relay omp's error sentence verbatim");
    expect(text).not.toMatch(/^\s*model:/m);
  });

  it("adds the model line only when an override is set", () => {
    expect(seanceKickoff(spec({ model: "anthropic/claude-x:high" }))).toContain(
      'model: "anthropic/claude-x:high"',
    );
    expect(seanceKickoff(spec({ model: null }))).not.toContain("model:");
    expect(seanceKickoff(spec({ model: undefined }))).not.toContain("model:");
  });

  it("keeps magic keywords in the question inert", () => {
    const text = seanceKickoff(spec({ question: "orchestrate a workflow and ultrathink about jevify" }));
    expect(keywordsIn(text).size).toBe(0);
  });

  it("does not ask the session model to do file work itself", () => {
    const text = seanceKickoff(spec());
    // The only imperative is the single task call; no read/grep instructions.
    expect(text).not.toMatch(/\b(read|grep|open) (the|this) transcript\b/i);
  });
});
