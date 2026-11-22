import { describe, expect, it } from "vitest";
import type { DiffRow } from "./omp-diff";
import { exchangeTotals, summarizeExchanges } from "./exchange-changes";
import type { RenderItem, ToolItem } from "./transcript";

function rows(spec: [DiffRow["kind"], string][]): DiffRow[] {
  return spec.map(([kind, text], i) => (kind === "meta" ? { kind, text } : { kind, lineNum: i + 1, text }));
}

function tool(id: string, diff: DiffRow[] | undefined, path?: string): ToolItem {
  return {
    kind: "tool",
    id,
    toolCallId: `${id}-call`,
    name: "edit",
    args: {},
    status: "done",
    ...(diff !== undefined ? { diff } : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

function user(id: string): RenderItem {
  return { kind: "user", id, text: "go" };
}

function assistant(id: string): RenderItem {
  return { kind: "assistant", id, text: "ok", thinking: "", narration: "", streaming: false };
}

describe("summarizeExchanges", () => {
  it("rolls up every diff card per exchange, keyed by anchor", () => {
    const items: RenderItem[] = [
      user("u1"),
      tool("t1", rows([["add", "a"], ["add", "b"], ["del", "c"]]), "src/a.ts"),
      tool("t2", rows([["del", "x"]]), "src/b.ts"),
      assistant("a1"),
      user("u2"),
      tool("t3", rows([["add", "new"]]), "src/c.ts"),
    ];
    const map = summarizeExchanges(items);
    expect([...map.keys()]).toEqual(["a1", "t3"]);

    const first = map.get("a1")!;
    expect(first.anchorId).toBe("a1");
    expect(first.entries.map((e) => e.itemId)).toEqual(["t1", "t2"]);
    expect(first.files).toBe(2);
    expect(exchangeTotals(first)).toEqual({ added: 2, removed: 2 });

    const second = map.get("t3")!;
    expect(second.files).toBe(1);
    expect(exchangeTotals(second)).toEqual({ added: 1, removed: 0 });
  });

  it("aliases the tool item's rows array instead of cloning it", () => {
    const diff = rows([["add", "a"]]);
    const map = summarizeExchanges([user("u1"), tool("t1", diff, "a.ts")]);
    expect(map.get("t1")!.entries[0]!.rows).toBe(diff);
  });

  it("keeps an exchange open across ambient marker/notice/irc rows", () => {
    const items: RenderItem[] = [
      user("u1"),
      tool("t1", rows([["add", "a"]]), "a.ts"),
      { kind: "marker", id: "m1", label: "turn" },
      { kind: "notice", id: "n1", text: "fyi" },
      { kind: "irc", id: "i1", from: "peer", text: "hey" },
      assistant("a1"),
      user("u2"),
    ];
    const map = summarizeExchanges(items);
    // One exchange, anchored at the content item after the ambient rows.
    expect([...map.keys()]).toEqual(["a1"]);
    expect(map.get("a1")!.entries.map((e) => e.itemId)).toEqual(["t1"]);
  });

  it("counts undefined paths once as one pseudo-file and dedupes real paths", () => {
    const items: RenderItem[] = [
      user("u1"),
      tool("t1", rows([["add", "a"]]), "src/a.ts"),
      tool("t2", rows([["del", "b"]]), "src/a.ts"),
      tool("t3", rows([["add", "c"]])),
      tool("t4", rows([["ctx", "d"]])),
    ];
    const map = summarizeExchanges(items);
    // src/a.ts (deduped) + one anonymous pseudo-file.
    expect(map.get("t4")!.files).toBe(2);
  });

  it("counts a zero-row entry as a file", () => {
    const map = summarizeExchanges([user("u1"), tool("t1", [], "a.ts")]);
    const changes = map.get("t1")!;
    expect(changes.files).toBe(1);
    expect(exchangeTotals(changes)).toEqual({ added: 0, removed: 0 });
  });

  it("omits exchanges without a diff-bearing card entirely", () => {
    const items: RenderItem[] = [
      user("u1"),
      assistant("a1"),
      tool("t1", undefined, "a.ts"), // a read card: no diff field
      user("u2"),
      assistant("a2"),
    ];
    expect(summarizeExchanges(items).size).toBe(0);
  });

  it("anchors on the last content item, even without its own diff", () => {
    const items: RenderItem[] = [
      user("u1"),
      tool("t1", rows([["add", "a"]]), "a.ts"),
      assistant("a1"),
      // A diff-less trailing tool card is still content: it becomes the anchor.
      tool("t2", undefined),
      { kind: "marker", id: "m1", label: "end" },
    ];
    const map = summarizeExchanges(items);
    expect([...map.keys()]).toEqual(["t2"]);
    expect(map.get("t2")!.entries.map((e) => e.itemId)).toEqual(["t1"]);
  });

  it("returns an empty map for an empty transcript", () => {
    expect(summarizeExchanges([]).size).toBe(0);
  });

  // Phase 2 (performance plan): totals moved out of the scan into a lazy
  // per-exchange reader. The reader sees every card of its exchange, however
  // far above the rendered window the oldest one sits — the scan is full-list
  // — and equal counts to the pre-Phase-2 eager numbers.
  it("counts rows for an exchange whose oldest card sits deep in history", () => {
    const items: RenderItem[] = [];
    // 200 settled exchanges of noise, then the measured one: its first card
    // is ~2,600 items above the tail window any view would slice.
    for (let i = 0; i < 200; i += 1) {
      items.push(user(`u${i}`), assistant(`a${i}`));
    }
    items.push(
      user("u-end"),
      tool("big-old", rows(Array.from({ length: 500 }, (_, i) => (i % 2 ? (["add", "x"] as [DiffRow["kind"], string]) : (["del", "y"] as [DiffRow["kind"], string])))), "src/old.ts"),
      tool("small-new", rows([["add", "z"]]), "src/new.ts"),
    );
    const changes = summarizeExchanges(items).get("small-new")!;
    expect(changes.files).toBe(2);
    expect(exchangeTotals(changes)).toEqual({ added: 251, removed: 250 });
  });

  it("keeps entries reference-equal to the item rows through the lazy reader", () => {
    const diff = rows([["add", "a"], ["del", "b"]]);
    const changes = summarizeExchanges([user("u1"), tool("t1", diff, "a.ts")]).get("t1")!;
    expect(changes.entries[0]!.rows).toBe(diff);
    // exchangeTotals reads through that same array; nothing cloned it.
    expect(exchangeTotals(changes)).toEqual({ added: 1, removed: 1 });
  });
});
