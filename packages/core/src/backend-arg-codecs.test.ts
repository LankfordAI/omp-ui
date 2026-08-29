import { describe, expect, it } from "vitest";
import {
  agentModeCodec,
  arrayOf,
  bool,
  branchListOptionsCodec,
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
  worktree: { mint: { branch: "omp-ui/feature", baseRef: "main" } },
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
});
