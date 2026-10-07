import { describe, expect, it } from "vitest";
import { withAttachmentRoutingContext } from "./attachment-routing";
import { withDocumentContext } from "./document-context";
import {
  queueChipCount,
  queueChipView,
  queueEntryDisplayText,
  supportsPromoteQueued,
  supportsRestoreQueue,
} from "./queue-chip";
import { emptySessionRuntime } from "./rpc-types";

describe("queueChipView", () => {
  it("hides the chip at zero in both states", () => {
    expect(queueChipView(true, 0)).toBeNull();
    expect(queueChipView(false, 0)).toBeNull();
  });

  it("keeps the running semantics unchanged", () => {
    // Mid-turn the count really is work waiting for this turn to finish.
    expect(queueChipView(true, 2)).toEqual({
      label: "queued: 2",
      title: "messages waiting for the current turn to finish",
    });
  });

  it("labels an idle count as parked and says how it drains", () => {
    // At idle there is no current turn, so nothing counted can be "waiting for
    // the current turn" — it is parked until an explicit new prompt (#181).
    const view = queueChipView(false, 1);
    expect(view?.label).toBe("parked: 1");
    expect(view?.title).toContain("do not run while the agent is idle");
    expect(view?.title).toContain("new prompt");
  });
});

describe("supportsPromoteQueued", () => {
  it.each([
    [null, false],
    ["18.4.5", false],
    ["18.4.6", true],
    ["19.0.0", true],
  ] as const)("at omp %s → %s", (version, expected) => {
    expect(supportsPromoteQueued(version)).toBe(expected);
  });
});

describe("supportsRestoreQueue", () => {
  it.each([
    [null, false],
    ["18.6.2", false],
    ["18.6.3", true],
    ["18.7.0", true],
  ] as const)("at omp %s → %s", (version, expected) => {
    expect(supportsRestoreQueue(version)).toBe(expected);
  });
});

describe("queueChipCount", () => {
  const session = (count: number, steering: string[], followUp: string[]) => ({
    ...emptySessionRuntime(),
    queuedMessageCount: count,
    queuedMessages: { steering, followUp },
  });

  it("shows the listed total when queue_update is ahead of get_state's count", () => {
    expect(queueChipCount(session(0, ["s1"], ["f1", "f2"]))).toBe(3);
  });

  it("shows the count when it covers items the list omits (advisor cards, deferred)", () => {
    expect(queueChipCount(session(5, [], ["f1"]))).toBe(5);
  });

  it("falls back to the count when no list was ever reported", () => {
    expect(queueChipCount({ ...emptySessionRuntime(), queuedMessageCount: 2 })).toBe(2);
  });
});

describe("queueEntryDisplayText", () => {
  it("strips the wire suffixes omp-ui adds back to the typed prose", () => {
    const wire = withAttachmentRoutingContext(
      withDocumentContext("compare these", [{ name: "a.pdf", path: "/tmp/a.pdf" }]),
      2,
    );
    expect(queueEntryDisplayText(wire)).toBe("compare these");
  });

  it("leaves a routing lookalike inside prose untouched", () => {
    const lookalike = withAttachmentRoutingContext("", 1);
    const text = `quoting ${lookalike} back to you\nand more`;
    expect(queueEntryDisplayText(text)).toBe(text);
  });
});
