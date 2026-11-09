import { describe, expect, it } from "vitest";
import { deviceTool, planDeviceCommand } from "./device-tool";

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
    expect(planDeviceCommand({ args: ["x".repeat(4097)] }, binding, "/o").kind).toBe("refused");
  });

  it.each(["--serial", "--udid", "--device", "--platform", "--session", "--config", "--state-dir"])(
    "refuses %s in both spaced and = forms",
    (flag) => {
      expect(planDeviceCommand({ args: ["snapshot", flag, "v"] }, binding, "/o").kind).toBe("refused");
      expect(planDeviceCommand({ args: ["snapshot", `${flag}=v`] }, binding, "/o").kind).toBe("refused");
      for (const command of ["targets", "profiles", "state", "use", "create", "rotate", "posture"]) {
        expect(planDeviceCommand({ args: [command, flag, "v"] }, binding, "/o")).toMatchObject({ kind: "refused", reason: `${flag} is fixed by omp-ui and cannot be passed.` });
        expect(planDeviceCommand({ args: [command, `${flag}=v`] }, binding, "/o")).toMatchObject({ kind: "refused", reason: `${flag} is fixed by omp-ui and cannot be passed.` });
      }
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

  it("preserves explicit screenshot output and scale options", () => {
    for (const args of [
      ["screenshot", "--out", "/tmp/custom.png", "--scale", "1"],
      ["screenshot", "--out=/tmp/custom.png", "--scale=1"],
    ]) {
      expect(planDeviceCommand({ args }, binding, "/tmp/o.png")).toEqual({ kind: "forward", argv: [...args, ...TAIL], screenshotOut: false });
    }
    expect(planDeviceCommand({ args: ["screenshot", "--scale=1"] }, binding, "/tmp/o.png")).toEqual({
      kind: "forward", argv: ["screenshot", "--scale=1", "--out", "/tmp/o.png", ...TAIL], screenshotOut: true,
    });
  });

  it.each([
    "open", "close", "apps", "appstate", "snapshot", "press", "click", "fill", "type", "longpress", "focus", "scroll", "swipe", "gesture",
    "back", "home", "app-switcher", "hardware-button", "wait", "is", "get", "find", "diff", "install", "reinstall", "uninstall", "logs", "keyboard",
    "clipboard", "orientation", "settings", "alert", "capabilities", "perf", "network", "trace", "record", "metro", "react-devtools", "react-native", "help",
  ])("retains the allowed %s app command", (command) => {
    expect(planDeviceCommand({ args: [command] }, binding, "/o")).toEqual({ kind: "forward", argv: [command, ...TAIL], screenshotOut: false });
    expect(planDeviceCommand({ args: [command] }, null, "/o").kind).toBe("refused");
  });

  it.each(["lock", "auto"])("leaves guest orientation %s forwarded rather than physically rotating", (policy) => {
    expect(planDeviceCommand({ args: ["orientation", policy] }, binding, "/o")).toEqual({
      kind: "forward", argv: ["orientation", policy, ...TAIL], screenshotOut: false,
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

  it("keeps legacy AVD selection distinct from explicit creation", () => {
    expect(planDeviceCommand({ args: ["use", "pixel_11_pro_fold_inner"] }, null, "/o")).toEqual({ kind: "use", target: { avd: "pixel_11_pro_fold_inner" } });
    expect(planDeviceCommand({ args: ["create", "pixel-11-pro-fold-inner", "system-images;android-35;google_apis;x86_64", "new_avd"] }, null, "/o").kind).toBe("refused");
  });

  it.each(["targets", "profiles", "state"] as const)("plans unbound %s without claiming readiness and refuses extra arguments", (command) => {
    expect(planDeviceCommand({ args: [command] }, null, "/o")).toEqual({ kind: command });
    expect(planDeviceCommand({ args: [command, "extra"] }, null, "/o").kind).toBe("refused");
  });

  it.each(["small_phone", "pixel_fold", "7.6in Foldable", "6.7in Foldable", "8in Foldable"])("plans explicit native creation of %s without pretending it is ready", (profileId) => {
    const imagePackage = "system-images;android-35;google_apis;x86_64";
    expect(planDeviceCommand({ args: ["create", profileId, imagePackage, "my_fold_35"] }, null, "/o")).toEqual({
      kind: "create", profileId, imagePackage, avd: "my_fold_35",
    });
  });

  it.each([
    ["create"], ["create", "pixel_fold"], ["create", "pixel_fold", "system-images;android-35;google_apis;x86_64"],
    ["create", "pixel_fold", "system-images;android-35;google_apis;x86_64", "new_avd", "extra"],
    ["create", "pixel_fold", "system-images;android-35-ext15;google_apis;x86_64", "new_avd", "extra"],
    ["use"], ["use", "valid_avd", "extra"], ["use", "valid_avd\n"], ["use", "emulator-5556\n"], ["use", "valid_avd --serial=emulator-5556"],
  ])("refuses malformed owner argv %j", (...args) => {
    expect(planDeviceCommand({ args }, null, "/o").kind).toBe("refused");
  });

  it.each(["", "pixel_fold ", "PIXEL_FOLD", "pixel_fold\n", "pixel_fold\u0000", "unknown", "pixel_fold --serial=emulator-5556"])("refuses invalid native profile %j", (profileId) => {
    expect(planDeviceCommand({ args: ["create", profileId, "system-images;android-35;google_apis;x86_64", "new_avd"] }, null, "/o").kind).toBe("refused");
  });

  it.each([
    "", ".", "..", "-new", "--force", "bad name", "../outside", "nested/avd", "new_avd\n", "new_avd\u0000", "new_avd --serial=emulator-5556", "x".repeat(129),
  ])("refuses invalid new AVD name %j", (avd) => {
    expect(planDeviceCommand({ args: ["create", "pixel_fold", "system-images;android-35;google_apis;x86_64", avd] }, null, "/o").kind).toBe("refused");
  });

  it.each([
    "", "android-35", "system-images;android-0;google_apis;x86_64", "system-images;android--35;google_apis;x86_64", "system-images;android-35.1;google_apis;x86_64",
    "system-images;android-35;android-tv;x86_64", "system-images;android-35;google_apis;x86",
    "system-images;android-35-ext;google_apis;x86_64", "system-images;android-35-ext0;google_apis;x86_64",
    "system-images;android-35-ext01;google_apis;x86_64", "system-images;android-35-ext-1;google_apis;x86_64",
    "system-images;android-35-ext1.5;google_apis;x86_64", "system-images;android-35-ext15-ext1;google_apis;x86_64",
    "system-images;android-9007199254740992-ext15;google_apis;x86_64", "system-images;android-35-ext9007199254740992;google_apis;x86_64",
    "system-images;android-35-ext15;google_apis;x86_64\n", "system-images;android-35-ext15;google_apis;x86_64 --force",
    "system-images;android-35;google_apis;x86_64\n", "system-images;android-35;google_apis;x86_64 --serial=emulator-5556",
    `system-images;android-${"9".repeat(256)};google_apis;x86_64`,
    `system-images;android-35-ext${"9".repeat(256)};google_apis;x86_64`,
  ])("refuses malformed or non-mobile image package %j", (imagePackage) => {
    expect(planDeviceCommand({ args: ["create", "pixel_fold", imagePackage, "new_avd"] }, null, "/o").kind).toBe("refused");
  });

  it.each([
    "system-images;android-35;default;x86_64", "system-images;android-35;google_apis;arm64-v8a", "system-images;android-35;google_apis_playstore;x86_64",
    "system-images;android-34-ext12;google_apis_playstore;x86_64",
    "system-images;android-35-ext15;google_apis;x86_64",
    "system-images;android-35-ext15;google_apis;arm64-v8a",
    "system-images;android-35-ext1;default;arm64-v8a",
  ])("preserves the exact installed image package %s for owner eligibility checks", (imagePackage) => {
    expect(planDeviceCommand({ args: ["create", "pixel_fold", imagePackage, "new_avd"] }, null, "/o")).toEqual({ kind: "create", profileId: "pixel_fold", imagePackage, avd: "new_avd" });
  });

  it.each([["0", 0], ["90", 1], ["180", 2], ["270", 3]] as const)("maps exact physical rotation %s to quadrant %s", (degrees, rotation) => {
    expect(planDeviceCommand({ args: ["rotate", degrees] }, null, "/o")).toEqual({ kind: "rotate", rotation });
  });

  it.each([[], ["-90"], ["360"], ["45"], ["1"], ["90.0"], ["090"], ["90deg"], ["90\n"], ["90", "extra"]])("refuses malformed physical rotation %j", (...angles) => {
    expect(planDeviceCommand({ args: ["rotate", ...angles] }, binding, "/o").kind).toBe("refused");
  });

  it.each(["closed", "half-open", "open", "flipped", "tent"] as const)("plans physical posture %s for owner capability checks", (posture) => {
    expect(planDeviceCommand({ args: ["posture", posture] }, null, "/o")).toEqual({ kind: "posture", posture });
  });

  it.each([[], ["half"], ["HALF_OPEN"], ["half-open\n"], ["90"], ["open", "extra"]])("refuses malformed posture %j", (...postures) => {
    expect(planDeviceCommand({ args: ["posture", ...postures] }, binding, "/o").kind).toBe("refused");
  });
});

describe("deviceTool", () => {
  it("explains asynchronous creation and physical controls without changing guest orientation policy", () => {
    const { description } = deviceTool();
    expect(description).toContain('never creates an absent AVD');
    expect(description).toContain('Creation is accepted asynchronously, not ready');
    expect(description).toContain('poll ["state"]');
    expect(description).toContain('physically rotates');
    expect(description).toContain('guest orientation lock/auto semantics');
  });
});
