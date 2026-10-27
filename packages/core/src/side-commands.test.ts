import { describe, expect, it } from "vitest";
import {
  SIDE_COMMANDS_STATUS_BYTE_LIMIT,
  parseFileSlashInvocation,
  parseSideCommandsSnapshot,
  sideCommandRenderMessage,
  sideCommandsArmMessage,
  sideCommandTitle,
} from "./side-commands";

const snapshot = {
  version: 1,
  processKey: "omp-ui-abc",
  revision: 1,
  available: true,
  unavailable: null,
  commands: ["sitrep"],
  result: null,
};
const parse = (value: unknown) => parseSideCommandsSnapshot(JSON.stringify(value));

describe("parseFileSlashInvocation", () => {
  it("splits at the first space only, like omp", () => {
    expect(parseFileSlashInvocation("/a")).toEqual({ name: "a", args: "" });
    expect(parseFileSlashInvocation("/a b  c")).toEqual({ name: "a", args: "b  c" });
    expect(parseFileSlashInvocation("/a\tb")).toEqual({ name: "a\tb", args: "" });
  });

  it("rejects non-slash lines and an empty name", () => {
    expect(parseFileSlashInvocation("x")).toBeNull();
    expect(parseFileSlashInvocation("/")).toBeNull();
  });
});

describe("sideCommandTitle", () => {
  it("drops whitespace-only args and trims the rest", () => {
    expect(sideCommandTitle("sitrep", "  \t ")).toBe("/sitrep");
    expect(sideCommandTitle("sitrep", " foo bar ")).toBe("/sitrep foo bar");
  });
});

describe("bridge messages", () => {
  it("arms and renders through the hidden command", () => {
    expect(sideCommandsArmMessage()).toBe("/omp-ui-side-commands");
    const request = { requestId: "r1", name: "sitrep", args: "a b" };
    expect(sideCommandRenderMessage(request)).toBe(
      `/omp-ui-side-commands render ${JSON.stringify(request)}`,
    );
  });
});

describe("parseSideCommandsSnapshot", () => {
  it("accepts both result shapes", () => {
    expect(parse(snapshot)).toEqual(snapshot);
    const ok = { requestId: "r1", ok: true, question: "q" };
    expect(parse({ ...snapshot, result: ok })?.result).toEqual(ok);
    const failed = { requestId: "r2", ok: false, reason: "render-failed", message: null };
    expect(parse({ ...snapshot, result: failed })?.result).toEqual(failed);
    const unavailable = { ...snapshot, available: false, unavailable: "missing-api", commands: [] };
    expect(parse(unavailable)).toEqual(unavailable);
  });

  it("rejects malformed snapshots", () => {
    expect(
      parse({ ...snapshot, result: { requestId: "r", ok: false, reason: "nope", message: null } }),
    ).toBeNull();
    expect(parse({ ...snapshot, unavailable: "no-session" })).toBeNull();
    expect(parse({ ...snapshot, available: false })).toBeNull();
    expect(parse({ ...snapshot, commands: ["ok", 1] })).toBeNull();
    expect(parse({ ...snapshot, revision: 0 })).toBeNull();
    expect(parseSideCommandsSnapshot(undefined)).toBeNull();
    expect(parseSideCommandsSnapshot("not json")).toBeNull();
  });

  it("rejects input over the byte limit", () => {
    const big = { ...snapshot, pad: "x".repeat(SIDE_COMMANDS_STATUS_BYTE_LIMIT) };
    expect(parse(big)).toBeNull();
  });
});
