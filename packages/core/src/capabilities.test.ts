import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_COMMAND,
  CAPABILITY_DESCRIPTION_LIMIT,
  CAPABILITY_STATUS_BYTE_LIMIT,
  capabilitiesMessage,
  parseCapabilitySnapshot,
  type CapabilitySnapshot,
} from "./capabilities";

function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "alpha",
    description: "reads a file",
    descriptionTruncated: false,
    source: "builtin",
    sourcePath: "/omp/tools/alpha.ts",
    enabled: true,
    direct: true,
    xdev: false,
    evalBridge: false,
    mcpServerName: null,
    mcpToolName: null,
    ...overrides,
  };
}

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "grill",
    description: "grills the plan",
    descriptionTruncated: false,
    filePath: "/skills/grill/SKILL.md",
    source: "user",
    scope: "user",
    hidden: null,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    processKey: "proc-1",
    sessionId: "session-1",
    revision: 3,
    updatedAt: 1_725_000_000_000,
    ompVersion: "18.1.10",
    skillCommandsEnabled: true,
    skills: { status: "available", items: [skill()] },
    tools: { status: "available", items: [tool()] },
    ...overrides,
  };
}

function parse(value: unknown): CapabilitySnapshot | null {
  return parseCapabilitySnapshot(JSON.stringify(value));
}

describe("parseCapabilitySnapshot", () => {
  it("round-trips a valid full snapshot through a freshly constructed DTO", () => {
    const source = snapshot();
    const parsed = parse(source);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(source);
  });

  it("keeps a valid empty roster available, never conflated with unavailable", () => {
    const parsed = parse(
      snapshot({
        skills: { status: "available", items: [] },
        tools: { status: "available", items: [] },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.skills).toEqual({ status: "available", items: [] });
    expect(parsed!.tools).toEqual({ status: "available", items: [] });
    expect(parsed!.skills.status).not.toBe("unavailable");
  });

  it("rejects the WHOLE snapshot when one member is malformed", () => {
    expect(parse(snapshot({ tools: { status: "available", items: [tool(), { name: "broken" }] } }))).toBeNull();
    expect(parse(snapshot({ skills: { status: "available", items: [{ filePath: "/no/name" }] } }))).toBeNull();
  });

  it("drops unknown fields, so smuggled secrets never reach the output DTO", () => {
    const parsed = parse(
      snapshot({
        apiToken: "sk-top-secret",
        skills: { status: "available", items: [skill({ token: "sk-skill-secret" })] },
        tools: { status: "available", items: [tool({ apiKey: "sk-tool-secret" })] },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.skills).toEqual({ status: "available", items: [skill()] });
    expect(parsed!.tools).toEqual({ status: "available", items: [tool()] });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it.each([0, 1.5, -2, Number.NaN])("rejects revision %p", (revision) => {
    expect(parse(snapshot({ revision }))).toBeNull();
  });

  it.each([2, 0, "1", null])("rejects version %p", (version) => {
    expect(parse(snapshot({ version }))).toBeNull();
  });

  it.each([null, "soon", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-finite updatedAt %p",
    (updatedAt) => {
      expect(parse(snapshot({ updatedAt }))).toBeNull();
    },
  );

  it("rejects invalid enum members", () => {
    expect(parse(snapshot({ tools: { status: "available", items: [tool({ source: "assistant" })] } }))).toBeNull();
    expect(parse(snapshot({ skills: { status: "available", items: [skill({ scope: "temporary" })] } }))).toBeNull();
    expect(parse(snapshot({ tools: { status: "unavailable", reason: "boom" } }))).toBeNull();
    expect(parse(snapshot({ skills: { status: "present" } }))).toBeNull();
  });

  it("rejects duplicate tool names", () => {
    expect(parse(snapshot({ tools: { status: "available", items: [tool(), tool()] } }))).toBeNull();
  });

  it("enforces the truncation flag against the description length", () => {
    expect(parse(snapshot({ tools: { status: "available", items: [tool({ description: "short", descriptionTruncated: true })] } }))).toBeNull();
    const atCap = parse(
      snapshot({
        tools: {
          status: "available",
          items: [tool({ description: "x".repeat(CAPABILITY_DESCRIPTION_LIMIT), descriptionTruncated: true })],
        },
      }),
    );
    expect(atCap).not.toBeNull();
    const item = atCap!.tools.status === "available" ? atCap!.tools.items[0] : undefined;
    expect(item?.description.length).toBe(CAPABILITY_DESCRIPTION_LIMIT);
    expect(item?.descriptionTruncated).toBe(true);
  });

  it("rejects any description longer than the cap, flagged or not", () => {
    const tooLong = "x".repeat(CAPABILITY_DESCRIPTION_LIMIT + 1);
    expect(parse(snapshot({ tools: { status: "available", items: [tool({ description: tooLong })] } }))).toBeNull();
    expect(parse(snapshot({ skills: { status: "available", items: [skill({ description: tooLong })] } }))).toBeNull();
  });

  it("measures the frame in UTF-8 bytes, not UTF-16 units (astral filler)", () => {
    const fatTools = (description: string) =>
      Array.from({ length: 170 }, (_unused, index) =>
        tool({ name: "tool-" + index, description, sourcePath: null }),
      );
    // 512 astral glyphs are 1024 UTF-16 units but 2048 UTF-8 bytes per tool:
    // every member is structurally valid; only the byte budget says no.
    const astral = "🧠".repeat(512);
    expect(astral.length).toBe(1_024);
    const big = JSON.stringify(snapshot({ tools: { status: "available", items: fatTools(astral) } }));
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(CAPABILITY_STATUS_BYTE_LIMIT);
    expect(parseCapabilitySnapshot(big)).toBeNull();

    const sameShape = JSON.stringify(
      snapshot({ tools: { status: "available", items: fatTools("a".repeat(1_024)) } }),
    );
    expect(Buffer.byteLength(sameShape, "utf8")).toBeLessThanOrEqual(CAPABILITY_STATUS_BYTE_LIMIT);
    expect(parseCapabilitySnapshot(sameShape)).not.toBeNull();
  });

  it("rejects non-text and non-object frames", () => {
    expect(parseCapabilitySnapshot(undefined)).toBeNull();
    expect(parseCapabilitySnapshot("")).toBeNull();
    expect(parseCapabilitySnapshot("not json")).toBeNull();
    expect(parseCapabilitySnapshot("[1,2]")).toBeNull();
    expect(parseCapabilitySnapshot('{"version":1}')).toBeNull();
  });
});

describe("capabilitiesMessage", () => {
  it("is the hidden slash command that arms the bridge", () => {
    expect(capabilitiesMessage()).toBe("/omp-ui-capabilities");
    expect(capabilitiesMessage()).toBe("/" + CAPABILITIES_COMMAND);
  });
});
