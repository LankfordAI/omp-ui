import { describe, expect, it } from "vitest";
import { queueChipView } from "./queue-chip";

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
