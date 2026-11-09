import { describe, expect, it } from "vitest";
import {
  agentModeCodec,
  arrayOf,
  bool,
  branchListOptionsCodec,
  browserPaneInputCodec,
  browserPaneNavigateCodec,
  devicePaneActionCodec,
  devicePaneInputCodec,
  checkoutOptionsCodec,
  consoleProgramCodec,
  imageAttachmentCodec,
  lit,
  mcpSetEnabledRequestCodec,
  nullable,
  num,
  objectOf,
  ompSettingValueCodec,
  oneOf,
  optional,
  planFormatCodec,
  projectOpenTargetCodec,
  record,
  remoteBindCodec,
  rpcFrameCodec,
  sessionModeCodec,
  spawnRequestCodec,
  worktreeReleaseOptionsCodec,
  str,
  trailingOptional,
} from "./backend-arg-codecs";
import type { SpawnRequest } from "./types";

const decode = <T>(codec: { decode(value: unknown, path: string): T }, value: unknown): T =>
  codec.decode(value, "argument 0");

const validSpawnRequest: SpawnRequest = {
  origin: "new",
  mode: "rpc-ui",
  projectCwd: "/project",
  advisor: true,
  advisorModel: "openrouter/advisor",
  cols: 120,
  rows: 40,
  worktree: { mint: { branch: "omp-ui/main/feature", baseRef: "main", baseBranch: null } },
  planMode: false,
  planImplementationSource: {
    sourceTabId: "planning-tab",
    planTitle: "Accepted plan",
    planFilePath: "local://plans/accepted.md",
  },
};

describe("primitive argument codecs", () => {
  it("accepts exact primitive types without adding domain policy", () => {
    expect(decode(str(), "")).toBe("");
    expect(decode(num(), -1.5)).toBe(-1.5);
    expect(decode(bool(), false)).toBe(false);
    expect(decode(lit("image"), "image")).toBe("image");
    expect(decode(oneOf("a", "b"), "b")).toBe("b");
  });

  it.each([
    [str(), 1],
    [num(), Number.NaN],
    [num(), Number.POSITIVE_INFINITY],
    [bool(), 0],
    [lit("image"), "video"],
    [oneOf("a", "b"), "c"],
  ])("rejects a mismatched value", (codec, value) => {
    expect(() => codec.decode(value, "argument 0")).toThrow(/^argument 0 must be /);
  });

  it("validates arrays in place", () => {
    const value = ["a", "b"];
    expect(decode(arrayOf(str()), value)).toBe(value);
    expect(() => decode(arrayOf(str()), ["a", 2])).toThrow("argument 0[1]");
  });
});

describe("nullable and optional argument codecs", () => {
  it("keeps null distinct from undefined", () => {
    expect(decode(nullable(str()), null)).toBeNull();
    expect(() => decode(nullable(str()), undefined)).toThrow();
    expect(decode(optional(str()), undefined)).toBeUndefined();
    expect(() => decode(optional(str()), null)).toThrow();
  });

  it("normalizes omitted and WebSocket-null trailing positions", () => {
    expect(decode(trailingOptional(str()), undefined)).toBeUndefined();
    expect(decode(trailingOptional(str()), null)).toBeUndefined();
    expect(decode(trailingOptional(str()), "value")).toBe("value");
  });

  it("collapses a wire-null remote to omitted like a missing one", () => {
    const remote = trailingOptional(nullable(str()));
    expect(decode(remote, "origin")).toBe("origin");
    expect(decode(remote, undefined)).toBeUndefined();
    expect(decode(remote, null)).toBeUndefined();
    expect(() => decode(remote, { force: true })).toThrow("argument 0 must be a string");
  });
});

describe("object codecs", () => {
  const nested = objectOf({
    name: str(),
    options: objectOf({ enabled: bool(), label: optional(str()) }),
  });

  it("validates declared fields and preserves object identity", () => {
    const value = { name: "server", options: { enabled: true } };
    expect(decode(nested, value)).toBe(value);
    expect(decode(branchListOptionsCodec, {})).toEqual({});
    expect(decode(checkoutOptionsCodec, { create: true })).toEqual({ create: true });
  });

  it("rejects missing, unknown, invalid nested, and non-plain objects", () => {
    expect(() => decode(nested, { options: { enabled: true } })).toThrow("argument 0.name");
    expect(() => decode(nested, { name: "server", options: { enabled: true }, extra: 1 })).toThrow(
      "argument 0 must be an object with the declared fields",
    );
    expect(() => decode(nested, { name: "server", options: { enabled: "yes" } })).toThrow(
      "argument 0.options.enabled",
    );
    expect(() => decode(nested, [])).toThrow();
    expect(() => decode(nested, new Date())).toThrow();
  });

  it("allows arbitrary own fields only for open records", () => {
    const frame = { type: undefined, custom: { nested: true } };
    expect(decode(record(), frame)).toBe(frame);
    expect(decode(rpcFrameCodec, frame)).toBe(frame);
    expect(() => decode(rpcFrameCodec, [])).toThrow();
  });
});

describe("domain argument codecs", () => {
  it.each([
    [sessionModeCodec, ["pty", "rpc-ui"]],
    [agentModeCodec, ["plan", "build"]],
    [planFormatCodec, ["html", "md"]],
    [projectOpenTargetCodec, ["vscode", "files", "terminal"]],
    [consoleProgramCodec, ["shell", "omp-tui"]],
    [remoteBindCodec, ["localhost", "lan"]],
  ] as const)("accepts every literal member and rejects another string", (codec, values) => {
    for (const value of values) expect(decode(codec, value)).toBe(value);
    expect(() => decode(codec, "invalid")).toThrow();
  });

  it("validates image attachments without copying their payload", () => {
    const image = { type: "image" as const, data: "A".repeat(1024), mimeType: "image/png" };
    expect(decode(imageAttachmentCodec, image)).toBe(image);
    expect(() => decode(imageAttachmentCodec, { ...image, type: "file" })).toThrow(
      "argument 0.type",
    );
  });

  it("validates MCP and branch option objects", () => {
    const request = { projectCwd: null, name: "github", enabled: true };
    expect(decode(mcpSetEnabledRequestCodec, request)).toBe(request);
    expect(decode(mcpSetEnabledRequestCodec, { ...request, sourcePath: undefined })).toEqual({
      ...request,
      sourcePath: undefined,
    });
    expect(() => decode(mcpSetEnabledRequestCodec, { ...request, sourcePath: null })).toThrow(
      "argument 0.sourcePath",
    );
    expect(() => decode(branchListOptionsCodec, { fetchUpstream: null })).toThrow(
      "argument 0.fetchUpstream",
    );
  });

  it("decodes worktree release options exactly", () => {
    const opts = { keepBranch: true, mergedInto: "release/x" };
    expect(decode(worktreeReleaseOptionsCodec, opts)).toBe(opts);
    // An absent `checkoutOnReturn` is an older remote instance (issue #416),
    // which predates #431 and sends the two fields it knows: it must decode.
    expect(
      decode(worktreeReleaseOptionsCodec, { keepBranch: false, mergedInto: null }),
    ).toEqual({ keepBranch: false, mergedInto: null });
    expect(
      decode(worktreeReleaseOptionsCodec, {
        keepBranch: false,
        mergedInto: null,
        checkoutOnReturn: null,
      }),
    ).toEqual({ keepBranch: false, mergedInto: null, checkoutOnReturn: null });
    expect(
      decode(worktreeReleaseOptionsCodec, {
        keepBranch: true,
        mergedInto: "release/x",
        checkoutOnReturn: "release/x",
      }),
    ).toEqual({ keepBranch: true, mergedInto: "release/x", checkoutOnReturn: "release/x" });
    expect(() =>
      decode(worktreeReleaseOptionsCodec, {
        keepBranch: false,
        mergedInto: null,
        checkoutOnReturn: 7,
      }),
    ).toThrow("argument 0.checkoutOnReturn");
    expect(() => decode(worktreeReleaseOptionsCodec, { keepBranch: true })).toThrow(
      "argument 0.mergedInto",
    );
    expect(() =>
      decode(worktreeReleaseOptionsCodec, { keepBranch: "yes", mergedInto: null }),
    ).toThrow("argument 0.keepBranch");
    expect(() =>
      decode(worktreeReleaseOptionsCodec, { keepBranch: false, mergedInto: null, force: true }),
    ).toThrow();
  });

  it("accepts every OMP setting value shape and rejects invalid members", () => {
    const open = { nested: undefined };
    for (const value of [true, 2.5, "", ["a", "b"], open]) {
      expect(decode(ompSettingValueCodec, value)).toBe(value);
    }
    expect(() => decode(ompSettingValueCodec, Number.NaN)).toThrow();
    expect(() => decode(ompSettingValueCodec, ["a", 1])).toThrow("argument 0[1]");
    expect(() => decode(ompSettingValueCodec, null)).toThrow();
  });

  it("delegates spawn parsing and reports only the static boundary shape", () => {
    expect(decode(spawnRequestCodec, validSpawnRequest)).toEqual(validSpawnRequest);
    expect(decode(spawnRequestCodec, validSpawnRequest)).not.toBe(validSpawnRequest);
    expect(() =>
      decode(spawnRequestCodec, { ...validSpawnRequest, secretInput: "do-not-echo" }),
    ).toThrow("argument 0 must be a valid spawn request");
    try {
      decode(spawnRequestCodec, { ...validSpawnRequest, secretInput: "do-not-echo" });
    } catch (error) {
      expect(String(error)).not.toContain("secretInput");
      expect(String(error)).not.toContain("do-not-echo");
    }
  });

  it("decodes every browser pane input arm strictly", () => {
    const events = [
      { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1, modifiers: ["shift"] },
      { type: "mouseUp", x: 10, y: 20 },
      { type: "mouseMove", x: 0.5, y: 8192 },
      { type: "mouseLeave", x: -1, y: -1 },
      { type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: -120, hasPreciseScrollingDeltas: false },
      { type: "keyDown", keyCode: "Enter", modifiers: ["control", "meta"] },
      { type: "keyUp", keyCode: "Enter" },
      { type: "char", keyCode: "a" },
      { type: "insertText", text: "héllo" },
      { type: "imeSetComposition", text: "한", selectionStart: 1, selectionEnd: 1 },
      { type: "edit", command: "paste" },
    ];
    for (const event of events) expect(decode(browserPaneInputCodec, event)).toEqual(event);

    expect(() => decode(browserPaneInputCodec, { type: "mouseUp", x: 1, y: 2, extra: true })).toThrow();
    expect(() => decode(browserPaneInputCodec, { type: "mouseMove", x: Number.NaN, y: 2 })).toThrow(
      "argument 0.x",
    );
    expect(() => decode(browserPaneInputCodec, { type: "mouseMove", x: 8193, y: 2 })).toThrow(
      "argument 0.x",
    );
    expect(() => decode(browserPaneInputCodec, { type: "keyDown", keyCode: "K".repeat(65) })).toThrow(
      "argument 0.keyCode",
    );
    expect(() => decode(browserPaneInputCodec, { type: "edit", command: "format" })).toThrow(
      "argument 0.command",
    );
    expect(() =>
      decode(browserPaneInputCodec, {
        type: "imeSetComposition",
        text: "한",
        selectionStart: 1.5,
        selectionEnd: 1,
      }),
    ).toThrow("argument 0.selectionStart");
    expect(() =>
      decode(browserPaneInputCodec, { type: "imeSetComposition", text: "한", selectionStart: 1 }),
    ).toThrow("argument 0.selectionEnd");
    expect(() => decode(browserPaneInputCodec, { type: "scroll" })).toThrow("argument 0.type");
  });

  it("decodes browser pane navigation with url only on goto", () => {
    const goto = { action: "goto", url: "https://example.com/" };
    expect(decode(browserPaneNavigateCodec, goto)).toEqual(goto);
    for (const action of ["back", "forward", "reload", "stop"]) {
      expect(decode(browserPaneNavigateCodec, { action })).toEqual({ action });
    }
    expect(() => decode(browserPaneNavigateCodec, { action: "goto" })).toThrow("argument 0.url");
    expect(() => decode(browserPaneNavigateCodec, { action: "back", url: "x" })).toThrow();
  });

  it("decodes identity-fenced device input with strict bounds", () => {
    const identity = { bindingId: "12345678-1234-4234-9234-123456789abc", geometryRevision: 1 };
    const events = [
      { type: "touch", phase: "down", x: 0, y: 1, pointer: 0 },
      { type: "touch", phase: "move", x: 0.5, y: 0.5, pointer: 9 },
      { type: "touch", phase: "up", x: 1, y: 0, pointer: 3 },
      { type: "wheel", x: 0.5, y: 0.5, dx: -10_000, dy: 10_000 },
      { type: "key", phase: "down", key: "Enter" },
      { type: "key", phase: "up", key: "a" },
      { type: "text", text: "héllo 한" },
      ...["back", "home", "recents", "power"].map((button) => ({ type: "button", button })),
    ];
    for (const event of events) {
      expect(decode(devicePaneInputCodec, { ...identity, ...event })).toEqual({ ...identity, ...event });
      expect(() => decode(devicePaneInputCodec, event)).toThrow("argument 0.bindingId");
      expect(() => decode(devicePaneInputCodec, { ...identity, ...event, extra: true })).toThrow("argument 0.extra");
    }
    const touch = { ...identity, type: "touch", phase: "down", x: 0, y: 0, pointer: 0 };
    for (const [field, values] of Object.entries({ x: [-0.01, 1.01, NaN, Infinity], y: [-1, 2], pointer: [-1, 10, 0.5], geometryRevision: [0, -1, 0.5, 0x1_0000_0000, NaN] })) {
      for (const value of values) expect(() => decode(devicePaneInputCodec, { ...touch, [field]: value })).toThrow(`argument 0.${field}`);
    }
    expect(decode(devicePaneInputCodec, { ...touch, geometryRevision: 0xffff_ffff })).toEqual({ ...touch, geometryRevision: 0xffff_ffff });
    for (const bindingId of [null, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000", "12345678-1234-4234-1234-123456789abc"]) {
      expect(() => decode(devicePaneInputCodec, { ...touch, bindingId })).toThrow("argument 0.bindingId");
    }
    for (const event of [
      { type: "wheel", x: 0, y: 0, dx: 10_001, dy: 0 },
      { type: "key", phase: "down", key: "K".repeat(33) },
      { type: "text", text: "x".repeat(1025) },
      { type: "button", button: "menu" },
      { type: "touch", phase: "down", x: 0, y: 0 },
      { type: "swipe" },
    ]) expect(() => decode(devicePaneInputCodec, { ...identity, ...event })).toThrow();
  });

  it("decodes all v2 actions and rejects old or malformed payloads", () => {
    const bindingId = "12345678-1234-4234-9234-123456789abc";
    const create = { action: "create", profileId: "7.6in Foldable", imagePackage: "system-images;android-35;google_apis;x86_64", avd: "My_Fold" };
    const actions = [
      { action: "bind", serial: "emulator-5554" },
      { action: "boot", avd: "Pixel_8_API_35" },
      create,
      ...[
        "system-images;android-34-ext12;google_apis_playstore;x86_64",
        "system-images;android-35-ext15;google_apis;x86_64",
        "system-images;android-35-ext15;google_apis;arm64-v8a",
        "system-images;android-35-ext1;default;arm64-v8a",
      ].map((imagePackage) => ({ ...create, imagePackage })),
      ...[0, 1, 2, 3].map((rotation) => ({ action: "rotate", bindingId, rotation })),
      ...["closed", "half-open", "open", "flipped", "tent"].map((posture) => ({ action: "set-posture", bindingId, posture })),
      ...["unbind", "power-off", "refresh"].map((action) => ({ action, bindingId })),
      { action: "refresh", bindingId: null },
    ];
    for (const action of actions) {
      expect(decode(devicePaneActionCodec, action)).toEqual(action);
      expect(() => decode(devicePaneActionCodec, { ...action, extra: true })).toThrow("argument 0.extra");
    }
    for (const action of ["unbind", "power-off", "refresh"]) expect(() => decode(devicePaneActionCodec, { action })).toThrow("argument 0.bindingId");
    for (const rotation of [-1, 4, 90, 0.5, NaN, "1"]) expect(() => decode(devicePaneActionCodec, { action: "rotate", bindingId, rotation })).toThrow("argument 0.rotation");
    for (const action of [
      { action: "bind", serial: "192.168.1.5:5555" },
      { action: "bind", serial: "emulator-5554\n" },
      { action: "boot", avd: "Pixel\n" },
      { action: "unbind", bindingId: `${bindingId}\n` },
      { ...create, imagePackage: `${create.imagePackage}\n` },
      { action: "boot", avd: "../evil" },
      { action: "boot", avd: "a".repeat(129) },
      { action: "unbind", bindingId: null },
      { action: "rotate", bindingId: "invalid", rotation: 0 },
      { action: "set-posture", bindingId, posture: "half" },
      { ...create, profileId: "" },
      { ...create, profileId: "a".repeat(129) },
      { ...create, profileId: "a\n" },
      ...[
        "system-images;android-35-ext;google_apis;x86_64",
        "system-images;android-35-ext0;google_apis;x86_64",
        "system-images;android-35-ext01;google_apis;x86_64",
        "system-images;android-35-ext-1;google_apis;x86_64",
        "system-images;android-35-ext1.5;google_apis;x86_64",
        "system-images;android-35-ext15-ext1;google_apis;x86_64",
        "system-images;android-9007199254740992-ext15;google_apis;x86_64",
        "system-images;android-35-ext9007199254740992;google_apis;x86_64",
        "system-images;android-35-ext15;google_apis;x86_64\n",
        "system-images;android-35-ext15;google_apis;x86_64 --force",
        `system-images;android-35-ext${"9".repeat(256)};google_apis;x86_64`,
      ].map((imagePackage) => ({ ...create, imagePackage })),
      { ...create, imagePackage: "system-images;android-35;google_apis;x86" },
      { action: "wipe" },
    ]) expect(() => decode(devicePaneActionCodec, action)).toThrow();
  });
});
