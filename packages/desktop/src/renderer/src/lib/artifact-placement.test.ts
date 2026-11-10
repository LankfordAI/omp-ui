import { HTML_ARTIFACT_TOOL_NAME } from "@omp-ui/core/html-artifact";
import { describe, expect, it } from "vitest";
import { presentArtifacts } from "./artifact-placement";
import type { RenderItem, ToolItem } from "./transcript";

function user(id: string): RenderItem {
  return { kind: "user", id, text: "go" };
}

function reply(id: string, stopReason: string | undefined, streaming = false): RenderItem {
  return {
    kind: "assistant", id, text: "ok", thinking: "", narration: "", streaming,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function tool(id: string, name: string, status: ToolItem["status"]): ToolItem {
  return { kind: "tool", id, toolCallId: `${id}-call`, name, args: {}, status };
}

function marker(id: string, label: string): RenderItem {
  return { kind: "marker", id, label };
}

function art(id: string, status: ToolItem["status"] = "done"): ToolItem {
  return tool(id, HTML_ARTIFACT_TOOL_NAME, status);
}

function ids(items: RenderItem[]): string[] {
  return items.map((item) => item.id);
}

describe("presentArtifacts", () => {
  for (const running of [true, false]) {
    it(`moves an artifact above the first final reply (running=${running})`, () => {
      const items = [
        user("u"), reply("a1", "toolUse"), art("art"), reply("a2", "toolUse"),
        tool("t1", "bash", "done"), reply("a3", "stop"), marker("m", "agent finished"),
      ];
      const result = presentArtifacts(items, running);
      expect(ids(result.items)).toEqual(["u", "a1", "a2", "t1", "art", "a3", "m"]);
      expect(result.deferred.size).toBe(0);
    });
  }

  it("keeps call order for several artifacts anchored to the first reply", () => {
    const items = [
      user("u"), art("art1"), tool("t1", "bash", "done"), art("art2"),
      reply("a1", "stop"), tool("t2", "bash", "done"), reply("a2", "stop"),
    ];
    const result = presentArtifacts(items, false);
    expect(ids(result.items)).toEqual(["u", "t1", "art1", "art2", "a1", "t2", "a2"]);
  });

  it("holds an artifact in place while the run has no final reply", () => {
    const items = [user("u"), art("art"), tool("t1", "bash", "done"), reply("a1", undefined, true)];
    const result = presentArtifacts(items, true);
    expect(result.items).toBe(items);
    expect([...result.deferred]).toEqual(["art"]);
  });

  it("lands after the last content item once idle with no final reply", () => {
    const items = [
      user("u"), reply("a0", "toolUse"), art("art"),
      tool("t1", "bash", "cancelled"), marker("m", "agent finished"),
    ];
    const result = presentArtifacts(items, false);
    expect(ids(result.items)).toEqual(["u", "a0", "t1", "art", "m"]);
    expect(result.deferred.size).toBe(0);
  });

  it("never holds in or crosses out of a closed segment while running", () => {
    const items = [user("u1"), art("art"), tool("t1", "bash", "done"), user("u2"), reply("a1", "stop")];
    const result = presentArtifacts(items, true);
    expect(ids(result.items)).toEqual(["u1", "t1", "art", "u2", "a1"]);
    expect(result.deferred.size).toBe(0);
  });

  it("moves only done render_html items", () => {
    const items = [
      user("u"), art("r1", "running"), art("r2", "error"), art("r3", "cancelled"),
      art("r4", "aborted"), tool("t1", "bash", "done"), reply("a1", "stop"),
    ];
    const result = presentArtifacts(items, false);
    expect(result.items).toBe(items);
    expect(result.deferred.size).toBe(0);
  });

  it("does not treat a reply without stopReason as final", () => {
    const items = [user("u"), art("art"), tool("t1", "bash", "done"), reply("a1", undefined)];
    const result = presentArtifacts(items, false);
    expect(ids(result.items)).toEqual(["u", "t1", "a1", "art"]);
  });
});
