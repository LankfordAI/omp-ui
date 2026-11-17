import { describe, expect, it } from "vitest";
import { agentEndAwaitsAsyncWork, isAgentPauseFrame, isNonTerminalAgentEnd } from "./run-end";

describe("isNonTerminalAgentEnd (issue #1192)", () => {
  it("reads only an explicit isTerminal:false as a pause", () => {
    expect(isNonTerminalAgentEnd({ type: "agent_end", isTerminal: false })).toBe(true);
    // The run's terminal end, and every frame from an omp that predates the
    // flag, ends the run (upstream fromWireEvent keeps the same rule).
    expect(isNonTerminalAgentEnd({ type: "agent_end", isTerminal: true })).toBe(false);
    expect(isNonTerminalAgentEnd({ type: "agent_end" })).toBe(false);
    // A truthy-but-not-boolean value never flips an end into a pause.
    expect(isNonTerminalAgentEnd({ type: "agent_end", isTerminal: 0 })).toBe(false);
  });

  it("is false for every frame that is not agent_end", () => {
    expect(isNonTerminalAgentEnd({ type: "agent_start", isTerminal: false })).toBe(false);
    expect(isNonTerminalAgentEnd({ type: "turn_end" })).toBe(false);
    expect(isNonTerminalAgentEnd({})).toBe(false);
  });
});

describe("agentEndAwaitsAsyncWork (issue #1204)", () => {
  it("marks only a paused end whose only resume is background work", () => {
    expect(
      agentEndAwaitsAsyncWork({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true }),
    ).toBe(true);
    // A pause that queued input can also wake: parked on the person, not work.
    expect(agentEndAwaitsAsyncWork({ type: "agent_end", isTerminal: false })).toBe(false);
    expect(
      agentEndAwaitsAsyncWork({ type: "agent_end", isTerminal: false, awaitingAsyncWork: false }),
    ).toBe(false);
    // The flag means nothing on a terminal or legacy end.
    expect(agentEndAwaitsAsyncWork({ type: "agent_end", awaitingAsyncWork: true })).toBe(false);
  });
});

describe("isAgentPauseFrame (issue #1193)", () => {
  it("reads the raw-stream pause frame by its type alone", () => {
    // Upstream agent-session-events.ts: payload is messages / yielded /
    // awaiting, and the frame has no isTerminal field at all.
    expect(isAgentPauseFrame({ type: "agent_pause", messages: [], yielded: true, awaiting: true })).toBe(true);
    expect(isAgentPauseFrame({ type: "agent_pause" })).toBe(true);
  });

  it("is false for every other frame", () => {
    expect(isAgentPauseFrame({ type: "agent_end", isTerminal: false })).toBe(false);
    expect(isAgentPauseFrame({ type: "agent_start" })).toBe(false);
    expect(isAgentPauseFrame({})).toBe(false);
    expect(isAgentPauseFrame(null)).toBe(false);
    expect(isAgentPauseFrame("agent_pause")).toBe(false);
  });
});
