import { describe, expect, it } from "vitest";
import { planDeviceCommand } from "./device-tool";

const binding = { serial: "emulator-5554", session: "s1" };
const TAIL = ["--platform", "android", "--serial", "emulator-5554", "--session", "s1"];

describe("planDeviceCommand", () => {
  it("refuses a non-allowlisted command", () => {
    for (const cmd of ["boot", "devices", "batch", "mcp"]) {
      expect(planDeviceCommand({ args: [cmd] }, binding, "/tmp/o.png").kind).toBe("refused");
    }
  });

  it("refuses a malformed args shape", () => {
    expect(planDeviceCommand({ args: [] }, binding, "/o").kind).toBe("refused");
    expect(planDeviceCommand({ args: Array(65).fill("help") }, binding, "/o").kind).toBe("refused");
    expect(planDeviceCommand({ args: ["help"], x: 1 }, binding, "/o").kind).toBe("refused");
    expect(planDeviceCommand(["help"], binding, "/o").kind).toBe("refused");
    expect(planDeviceCommand({ args: [1] }, binding, "/o").kind).toBe("refused");
  });

  it.each(["--serial", "--udid", "--device", "--platform", "--session", "--config", "--state-dir"])(
    "refuses %s in both spaced and = forms",
    (flag) => {
      expect(planDeviceCommand({ args: ["snapshot", flag, "v"] }, binding, "/o").kind).toBe("refused");
      expect(planDeviceCommand({ args: ["snapshot", `${flag}=v`] }, binding, "/o").kind).toBe("refused");
    },
  );

  it("appends the bound platform, serial and session to a forward", () => {
    expect(planDeviceCommand({ args: ["press", "@e3", "--settle"] }, binding, "/o")).toEqual({
      kind: "forward",
      argv: ["press", "@e3", "--settle", ...TAIL],
      screenshotOut: false,
    });
  });

  it("gives a bare screenshot --out and --scale 0.5, but not one with a path", () => {
    expect(planDeviceCommand({ args: ["screenshot"] }, binding, "/tmp/o.png")).toEqual({
      kind: "forward",
      argv: ["screenshot", "--out", "/tmp/o.png", "--scale", "0.5", ...TAIL],
      screenshotOut: true,
    });
    expect(planDeviceCommand({ args: ["screenshot", "--scale", "1"] }, binding, "/tmp/o.png")).toEqual({
      kind: "forward",
      argv: ["screenshot", "--scale", "1", "--out", "/tmp/o.png", ...TAIL],
      screenshotOut: true,
    });
    expect(planDeviceCommand({ args: ["screenshot", "path.png"] }, binding, "/tmp/o.png")).toEqual({
      kind: "forward",
      argv: ["screenshot", "path.png", ...TAIL],
      screenshotOut: false,
    });
  });

  it("refuses a forward without a binding but still plans omp-ui verbs", () => {
    expect(planDeviceCommand({ args: ["snapshot", "-i"] }, null, "/o").kind).toBe("refused");
    expect(planDeviceCommand({ args: ["targets"] }, null, "/o")).toEqual({ kind: "targets" });
  });

  it("distinguishes a serial from an AVD in use", () => {
    expect(planDeviceCommand({ args: ["use", "emulator-5556"] }, null, "/o")).toEqual({
      kind: "use",
      target: { serial: "emulator-5556" },
    });
    expect(planDeviceCommand({ args: ["use", "Pixel_8_API_35"] }, null, "/o")).toEqual({
      kind: "use",
      target: { avd: "Pixel_8_API_35" },
    });
    expect(planDeviceCommand({ args: ["use", "bad name!"] }, null, "/o").kind).toBe("refused");
    expect(planDeviceCommand({ args: ["use"] }, null, "/o").kind).toBe("refused");
  });
});
