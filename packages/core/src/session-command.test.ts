import { describe, expect, it } from "vitest";
import {
  SESSION_COMMANDS,
  sessionCommandHasLateAck,
  sessionCommandIsOffChain,
} from "./session-command";

describe("live voice session commands (issue #778)", () => {
  it("registers the three verbs with omp's chain placement", () => {
    expect(SESSION_COMMANDS.live_start).toEqual({ lateAck: false, offChain: true });
    expect(SESSION_COMMANDS.live_stop).toEqual({ lateAck: false });
    expect(SESSION_COMMANDS.live_mute).toEqual({ lateAck: false });
  });

  it("live_start rides off-chain; live_stop and live_mute queue on the chain", () => {
    expect(sessionCommandIsOffChain("live_start")).toBe(true);
    expect(sessionCommandIsOffChain("live_stop")).toBe(false);
    expect(sessionCommandIsOffChain("live_mute")).toBe(false);
    for (const verb of ["live_start", "live_stop", "live_mute"])
      expect(sessionCommandHasLateAck(verb as "live_start")).toBe(false);
  });
});
