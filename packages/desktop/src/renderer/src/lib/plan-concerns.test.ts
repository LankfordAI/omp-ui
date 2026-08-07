import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisorNote, RenderItem } from "./transcript";
import {
  PLAN_CONCERNS_LEAD,
  PLAN_CONCERNS_WAIT_MS,
  PlanConcernWatcher,
  withConcerns,
  type PlanConcernIntent,
} from "./plan-concerns";

const TAB = "tab-watcher";

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

describe("withConcerns", () => {
  it("appends the block when present", () => {
    expect(withConcerns("base", "- [note] x")).toBe("base\n\n- [note] x");
  });

  it("returns base unchanged when there are no concerns", () => {
    expect(withConcerns("base", null)).toBe("base");
  });
});

describe("PlanConcernWatcher", () => {
  let items: RenderItem[];
  let notices: string[];
  let dispatches: Array<{ tabId: string; intent: PlanConcernIntent; concerns: string | null }>;
  let watcher: PlanConcernWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    items = [];
    notices = [];
    dispatches = [];
    watcher = new PlanConcernWatcher({
      getItems: () => items,
      onNotice: (tabId, text) => {
        notices.push(text);
      },
      onDispatch: (tabId, intent, concerns) => {
        dispatches.push({ tabId, intent, concerns });
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("begin emits the waiting notice and marks the wait active", () => {
    watcher.begin(TAB, { context: "existing", planText: null });
    expect(watcher.isActive(TAB)).toBe(true);
    expect(notices).toEqual([
      "verdict accepted — waiting for the advisor's review before the next step",
    ]);
  });

  it("feed with no new finding keeps the wait active and fires nothing", () => {
    watcher.begin(TAB, { context: "existing", planText: null });
    items.push({ kind: "marker", id: "m1", label: "tick" });
    watcher.feed(TAB);
    expect(dispatches).toHaveLength(0);
    expect(watcher.isActive(TAB)).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it("feed settles on a new advisory card, folding it exactly once", () => {
    watcher.begin(TAB, { context: "existing", planText: null });
    items.push(advisory("adv-1", [note("Hardcoded key", "blocker", "security")]));
    watcher.feed(TAB);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.concerns).toContain("- [blocker] (security) Hardcoded key");
    expect(dispatches[0]!.concerns).toContain(PLAN_CONCERNS_LEAD);
    expect(notices).toEqual([
      "verdict accepted — waiting for the advisor's review before the next step",
      "advisor's review folded into the implementation (1 concern)",
    ]);
    expect(watcher.isActive(TAB)).toBe(false);
    // A second feed on the settled wait is a no-op.
    watcher.feed(TAB);
    expect(dispatches).toHaveLength(1);
  });

  it("feed settles and folds when the review is tool-attached only, no 15s stall", () => {
    watcher.begin(TAB, { context: "existing", planText: null });
    items.push(toolDone("tool-1", [note("pin the toolchain", "concern", "ops")]));
    watcher.feed(TAB);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.concerns).toContain("pin the toolchain");
    expect(watcher.isActive(TAB)).toBe(false);
    expect(notices.at(-1)).toContain("(1 concern)");
  });

  it("feed never settles on a finding that predates the baseline", () => {
    items.push(advisory("adv-old", [note("old nit", "nit", "style")]));
    watcher.begin(TAB, { context: "existing", planText: null });
    watcher.feed(TAB);
    expect(dispatches).toHaveLength(0);
    expect(watcher.isActive(TAB)).toBe(true);
  });

  it("the deadline dispatches clean with no concerns when no review lands", async () => {
    watcher.begin(TAB, { context: "existing", planText: null });
    await vi.advanceTimersByTimeAsync(PLAN_CONCERNS_WAIT_MS);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.concerns).toBeNull();
    expect(dispatches[0]!.intent).toEqual({ context: "existing", planText: null });
    expect(notices).toHaveLength(1); // the waiting notice only — no "folded"
    expect(watcher.isActive(TAB)).toBe(false);
  });

  it("cancel clears the deadline so nothing fires", async () => {
    watcher.begin(TAB, { context: "existing", planText: null });
    watcher.cancel(TAB);
    expect(watcher.isActive(TAB)).toBe(false);
    await vi.advanceTimersByTimeAsync(PLAN_CONCERNS_WAIT_MS);
    expect(dispatches).toHaveLength(0);
  });

  it("a second begin re-baselines so only newer findings fold", () => {
    items.push(advisory("adv-1", [note("first", "nit", "style")]));
    watcher.begin(TAB, { context: "existing", planText: null });
    items.push(advisory("adv-2", [note("second", "concern", "ops")]));
    watcher.begin(TAB, { context: "existing", planText: null });
    items.push(advisory("adv-3", [note("third", "blocker", "security")]));
    watcher.feed(TAB);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.concerns).toContain("third");
    expect(dispatches[0]!.concerns).not.toContain("second");
    expect(dispatches[0]!.concerns).not.toContain("first");
    expect(watcher.isActive(TAB)).toBe(false);
  });
});
