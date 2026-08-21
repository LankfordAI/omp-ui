import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STALL_CONTINUE_CAP_NOTICE,
  STALL_CONTINUE_LEAD,
  STALL_CONTINUE_MAX,
  STALL_CONTINUE_SETTLE_MS,
  StallContinueWatcher,
} from "./stall-continue";

const TAB = "tab-stall";

describe("StallContinueWatcher", () => {
  let notices: Array<{ text: string; level: "info" | "warn" }>;
  let dispatches: string[];
  /** Stands in for the session being promptable; the store predicate gates on it. */
  let continuable: boolean;
  let watcher: StallContinueWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    notices = [];
    dispatches = [];
    continuable = true;
    watcher = new StallContinueWatcher({
      canContinue: () => continuable,
      onDispatch: (tabId) => {
        dispatches.push(tabId);
      },
      onNotice: (_tabId, text, level) => {
        notices.push({ text, level });
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches exactly once, after the settle window, with the continue lead", async () => {
    watcher.trigger(TAB);

    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS - 1);
    expect(dispatches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toBe(TAB);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("info");
    expect(notices[0]!.text).toContain("stall auto-continue #1");
    // The lead is what the store sends; assert it is the bounded continue prompt.
    expect(STALL_CONTINUE_LEAD).toContain("stalled");
  });

  it("stops after the consecutive-continue cap, notices once, and re-arms on reset", async () => {
    for (let i = 0; i < STALL_CONTINUE_MAX; i += 1) {
      watcher.trigger(TAB);
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    }
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX);

    // One stall past the cap: the watcher explains itself instead of dispatching.
    watcher.trigger(TAB);
    const capped = notices.filter((n) => n.text === STALL_CONTINUE_CAP_NOTICE);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.level).toBe("warn");
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX);

    // Further stalls must not repeat the explanation.
    watcher.trigger(TAB);
    expect(notices.filter((n) => n.text === STALL_CONTINUE_CAP_NOTICE)).toHaveLength(1);

    // A user prompt re-arms the streak, so auto-continue works again.
    watcher.reset(TAB);
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX + 1);
  });

  it("drops the dispatch when the tab is no longer continuable at fire time", async () => {
    watcher.trigger(TAB);
    continuable = false;
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toHaveLength(0);
    expect(notices).toHaveLength(0);

    // The count is unchanged: the next stall still gets its own attempt.
    continuable = true;
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(1);
  });

  it("reset during the settle window cancels the pending dispatch", async () => {
    watcher.trigger(TAB);
    watcher.reset(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("cancel drops state: a later trigger starts fresh", async () => {
    watcher.trigger(TAB);
    watcher.cancel(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toHaveLength(0);

    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(1);
  });

  it("a stall on top of a pending continue supersedes the old timer", async () => {
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS / 2);
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    // One dispatch per stall event, not two.
    expect(dispatches).toHaveLength(1);
    expect(notices.filter((n) => n.level === "info")).toHaveLength(1);
  });
});
