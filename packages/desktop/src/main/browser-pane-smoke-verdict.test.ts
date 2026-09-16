import { describe, expect, it } from "vitest";
import { SMOKE_EXIT, smokeExitCode } from "./browser-pane-smoke-verdict";

const passing = {
  frames: { count: 1, firstFrameIsJpeg: true },
  inputTest: [{ ok: true }, { ok: null }],
  quitPath: "once",
};

describe("browser pane smoke verdict", () => {
  it("requires a JPEG frame", () => {
    expect(smokeExitCode({ ...passing, frames: { count: 0, firstFrameIsJpeg: null } })).toBe(SMOKE_EXIT.noFrame);
  });

  it("fails a false input step but permits platform-skipped null steps", () => {
    expect(smokeExitCode({ ...passing, inputTest: [{ ok: false }] })).toBe(SMOKE_EXIT.inputFailed);
    expect(smokeExitCode({ ...passing, inputTest: [{ ok: null }] })).toBe(SMOKE_EXIT.ok);
  });

  it("gives the watchdog precedence", () => {
    expect(smokeExitCode({ ...passing, frames: { count: 0, firstFrameIsJpeg: false }, quitPath: "watchdog" }))
      .toBe(SMOKE_EXIT.watchdog);
  });
});
