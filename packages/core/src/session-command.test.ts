import { describe, expect, it } from "vitest";
import { sessionCommandHasLateAck, sessionCommandIsOffChain } from "./session-command";

describe("live voice session commands (issue #778, ADR-0071)", () => {
  it("live_connect rides off-chain; live_stop and live_mute queue on the chain", () => {
    expect(sessionCommandIsOffChain("live_connect")).toBe(true);
    expect(sessionCommandIsOffChain("live_stop")).toBe(false);
    expect(sessionCommandIsOffChain("live_mute")).toBe(false);
    expect(sessionCommandIsOffChain("live_start")).toBe(false);
    for (const verb of ["live_connect", "live_stop", "live_mute"] as const)
      expect(sessionCommandHasLateAck(verb)).toBe(false);
  });
});
