import { describe, expect, it } from "vitest";
import { CARRYOVER_MESSAGE_CHAR_CAP } from "@omp-ui/core/carryover-context";
import { composeCarryoverContext } from "./carryover-context";
import type { RenderItem } from "./transcript";

const user = (id: string, text: string): RenderItem => ({ kind: "user", id, text });
const assistant = (id: string, text: string): RenderItem => ({
  kind: "assistant",
  id,
  text,
  thinking: "",
  streaming: false,
});

describe("composeCarryoverContext", () => {
  it("keeps user/assistant prose in order", () => {
    const digest = composeCarryoverContext([
      user("u1", "hello"),
      assistant("a1", "hi there"),
      user("u2", "ship it"),
    ]);
    expect(digest).not.toBeNull();
    expect(digest!).toContain('<turn role="user">\nhello\n</turn>');
    expect(digest!.indexOf("hi there")).toBeLessThan(digest!.indexOf("ship it"));
  });

  it("skips tools, notices, advisories, IRC, plans, commands, shell rows, and markers", () => {
    const digest = composeCarryoverContext([
      user("u1", "hello"),
      { kind: "tool", id: "t1", toolCallId: "tc1", name: "read", args: {}, status: "done", resultText: "secrets" },
      { kind: "notice", id: "n1", text: "a notice" },
      { kind: "advisory", id: "ad1", notes: [{ note: "advisor said" }] },
      { kind: "irc", id: "i1", from: "agent", text: "irc line" },
      { kind: "plan", id: "p1", title: "Plan", planFilePath: "/p", planAbsPath: null, text: null, status: "pending" },
      { kind: "command", id: "c1", name: "mcp", args: "", status: "done", output: "cmd output" },
      { kind: "shell", id: "s1", command: "git log", status: "done", output: "shell output" },
      { kind: "marker", id: "m1", label: "a marker" },
      assistant("a1", "done"),
    ]);
    expect(digest).toContain("hello");
    expect(digest).toContain("done");
    for (const noise of ["secrets", "a notice", "advisor said", "irc line", "Plan", "cmd output", "shell output", "a marker", "git log"]) {
      expect(digest!).not.toContain(noise);
    }
  });

  it("skips blank messages and a streaming assistant that has yielded no text", () => {
    expect(
      composeCarryoverContext([
        user("u1", "   "),
        { kind: "assistant", id: "a1", text: "", thinking: "pondering", streaming: true },
      ]),
    ).toBeNull();
  });

  it("returns null when nothing survives", () => {
    expect(composeCarryoverContext([])).toBeNull();
    expect(
      composeCarryoverContext([
        { kind: "notice", id: "n1", text: "only a notice" },
      ]),
    ).toBeNull();
  });

  it("caps an oversized message at the per-message ceiling", () => {
    const digest = composeCarryoverContext([
      user("u1", "x".repeat(CARRYOVER_MESSAGE_CHAR_CAP + 900)),
    ]);
    expect(digest!).toContain("…");
    expect(digest!).not.toContain("x".repeat(CARRYOVER_MESSAGE_CHAR_CAP + 1));
  });

  it("stays under the parser's 65536-character ceiling for any transcript", () => {
    // Each message just under the per-message cap; far more of them than the
    // digest budget can carry. The spawn parser must never reject the seed.
    const each = "y".repeat(CARRYOVER_MESSAGE_CHAR_CAP - 1);
    const items: RenderItem[] = [];
    for (let i = 0; i < 200; i += 1) items.push(user(`u${i}`, each));
    const digest = composeCarryoverContext(items)!;
    expect(digest.length).toBeLessThanOrEqual(65_000);
    expect(digest).toContain("(earlier messages omitted)");
    expect(digest).toContain(each);
  });
});
