import { describe, expect, it } from "vitest";
import type { AdvisorNote, RenderItem } from "./transcript";
import { collectNewConcerns, renderConcernsBlock } from "./advisor-concerns";

const note = (text: string, severity?: string, advisor?: string): AdvisorNote => ({
  note: text,
  ...(severity !== undefined && { severity }),
  ...(advisor !== undefined && { advisor }),
});

/** An advisor's end-of-turn card. */
const advisory = (id: string, notes: AdvisorNote[]): RenderItem => ({ kind: "advisory", id, notes });

/** A done tool result — the plan turn's propose result can also carry notes. */
const toolDone = (id: string, notes: AdvisorNote[] = []): RenderItem => ({
  kind: "tool",
  id,
  toolCallId: `tc-${id}`,
  name: "propose",
  args: {},
  status: "done",
  ...(notes.length > 0 && { notes }),
});

describe("collectNewConcerns", () => {
  it("excludes findings at or before fromIndex and includes those after", () => {
    const items: RenderItem[] = [
      advisory("adv-1", [note("old", "nit", "style")]),
      { kind: "marker", id: "m1", label: "boundary" },
      advisory("adv-2", [note("new", "concern", "ops")]),
    ];
    expect(collectNewConcerns(items, 1)).toEqual([note("new", "concern", "ops")]);
  });

  it("collects notes from advisory cards and tool results alike", () => {
    const items: RenderItem[] = [
      advisory("adv-1", [note("card note", "nit", "style")]),
      toolDone("tool-1", [note("tool note", "concern", "ops")]),
    ];
    const out = collectNewConcerns(items, 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(note("card note", "nit", "style"));
    expect(out[1]).toEqual(note("tool note", "concern", "ops"));
  });

  it("dedupes an echoed note across the card and the tool result", () => {
    const echo = note("Hardcoded key", "blocker", "security");
    const items: RenderItem[] = [advisory("adv-1", [echo]), toolDone("tool-1", [echo])];
    expect(collectNewConcerns(items, 0)).toEqual([echo]);
  });

  it("dedupes repeats within a single card, first-seen order wins", () => {
    const items: RenderItem[] = [advisory("adv-1", [note("a"), note("b"), note("a")])];
    expect(collectNewConcerns(items, 0).map((n) => n.note)).toEqual(["a", "b"]);
  });

  it("returns [] when the baseline is past the end (history reload)", () => {
    const items: RenderItem[] = [advisory("adv-1", [note("a")])];
    expect(collectNewConcerns(items, items.length + 5)).toEqual([]);
    expect(collectNewConcerns([], 0)).toEqual([]);
  });
});

describe("renderConcernsBlock", () => {
  it("returns null for no notes", () => {
    expect(renderConcernsBlock([], "LEAD:")).toBeNull();
  });

  it("formats severity, advisor, and note exactly, defaulting severity", () => {
    const block = renderConcernsBlock(
      [
        { note: "no sev" },
        { note: "sev one", severity: "blocker" },
        { note: "sev two", severity: "concern", advisor: "ops" },
      ],
      "LEAD:",
    );
    expect(block).toBe(
      "LEAD:\n\n- [note] no sev\n- [blocker] sev one\n- [concern] (ops) sev two",
    );
  });
});
