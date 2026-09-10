import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STALL_CONTINUE_CAP_NOTICE,
  STALL_CONTINUE_LEAD,
  STALL_CONTINUE_MAX,
  STALL_CONTINUE_SETTLE_MS,
  StallContinueTracker,
  StallContinueWatcher,
} from "./stall-continue";
import type { LiveEntry } from "../live-entry";

const TAB = "tab-stall";

describe("StallContinueWatcher", () => {
  let notices: Array<{ text: string; level: "info" | "warn" }>;
  let dispatches: string[];
  /** Stands in for the session being promptable; the store predicate gates on it. */
  let continuable: boolean;
  let capChanges: Array<[string, boolean]>;
  let watcher: StallContinueWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    notices = [];
    dispatches = [];
    continuable = true;
    capChanges = [];
    watcher = new StallContinueWatcher({
      canContinue: () => continuable,
      onDispatch: (tabId) => {
        dispatches.push(tabId);
      },
      onNotice: (_tabId, text, level) => {
        notices.push({ text, level });
      },
      onCapChange: (tabId, paused) => {
        capChanges.push([tabId, paused]);
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

  it("reports the cap transition: true once at the cap, false on re-arm, never before", async () => {
    // Before the cap, continues dispatch but the guard never reports.
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(2);
    expect(capChanges).toHaveLength(0);

    // The first stall past the cap latches the pause — exactly one true.
    watcher.trigger(TAB);
    expect(capChanges).toEqual([[TAB, true]]);

    // Further stalls past the cap must not re-fire (capPosted latch).
    watcher.trigger(TAB);
    expect(capChanges).toEqual([[TAB, true]]);

    // A user prompt re-arms: exactly one false; a second reset is a no-op.
    watcher.reset(TAB);
    expect(capChanges).toEqual([[TAB, true], [TAB, false]]);
    watcher.reset(TAB);
    expect(capChanges).toEqual([[TAB, true], [TAB, false]]);

    // Erasing the tab reports false as well; cancelling a clean tab does not.
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    watcher.trigger(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    watcher.trigger(TAB);
    expect(capChanges).toEqual([[TAB, true], [TAB, false], [TAB, true]]);
    watcher.cancel(TAB);
    expect(capChanges).toEqual([[TAB, true], [TAB, false], [TAB, true], [TAB, false]]);
    watcher.cancel(TAB);
    expect(capChanges).toEqual([[TAB, true], [TAB, false], [TAB, true], [TAB, false]]);
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

describe("StallContinueTracker", () => {
  const rpcEntry = { kind: "rpc-ui" } as LiveEntry;
  const ptyEntry = { kind: "pty" } as LiveEntry;
  const stallEnd = {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "OpenAI responses stream stalled while waiting for the next event",
      errorId: 397312,
    },
  };
  const abortedEnd = {
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted" },
  };

  function setup() {
    const dispatches: string[] = [];
    const notices: Array<{ text: string; level: "info" | "warn" }> = [];
    const paused: Array<[string, boolean]> = [];
    const state = { continuable: true };
    const tracker = new StallContinueTracker({
      canContinue: () => state.continuable,
      dispatch: (tabId) => {
        dispatches.push(tabId);
      },
      notice: (_tabId, text, level) => {
        notices.push({ text, level });
      },
      attention: {
        turnStarted: () => {},
        turnEnded: () => {},
        planProposed: () => {},
        planSettled: () => {},
        stallPaused: (tabId, p) => {
          paused.push([tabId, p]);
        },
        sessionExit: () => {},
      },
    });
    const stalledTurn = (): void => {
      tracker.onFrame(TAB, { type: "agent_start" }, rpcEntry);
      tracker.onFrame(TAB, stallEnd, rpcEntry);
      tracker.onFrame(TAB, { type: "agent_end" }, rpcEntry);
    };
    return { tracker, dispatches, notices, paused, state, stalledTurn };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a provider-stall turn end dispatches the continue after the settle window", async () => {
    const { tracker, dispatches, notices, stalledTurn } = setup();
    stalledTurn();
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS - 1);
    expect(dispatches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatches).toEqual([TAB]);
    expect(notices).toEqual([{ text: expect.stringContaining("stall auto-continue #1"), level: "info" }]);

    // A clean end after the stall does not re-trigger: lastTurn was consumed.
    tracker.onFrame(TAB, { type: "agent_start" }, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_end" }, rpcEntry);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(1);
  });

  it("a watchdog abort makes the following aborted turn end a stall end", async () => {
    const { tracker, dispatches } = setup();
    tracker.onFrame(TAB, { type: "agent_start" }, rpcEntry);
    tracker.noteWatchdogAbort(TAB);
    tracker.onFrame(TAB, abortedEnd, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_end" }, rpcEntry);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toEqual([TAB]);

    // Consumed at the turn boundary: a plain user abort later does not continue.
    tracker.onFrame(TAB, { type: "agent_start" }, rpcEntry);
    tracker.onFrame(TAB, abortedEnd, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_end" }, rpcEntry);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(1);
  });

  it("non-stall ends, non-assistant message ends, and pty frames trigger nothing", async () => {
    const { tracker, dispatches } = setup();
    tracker.onFrame(TAB, { type: "agent_start" }, rpcEntry);
    tracker.onFrame(TAB, abortedEnd, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_end" }, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_start" }, rpcEntry);
    tracker.onFrame(TAB, { ...stallEnd, message: { ...stallEnd.message, role: "user" } }, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_end" }, rpcEntry);
    tracker.onFrame(TAB, { type: "agent_start" }, ptyEntry);
    tracker.onFrame(TAB, stallEnd, ptyEntry);
    tracker.onFrame(TAB, { type: "agent_end" }, ptyEntry);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toEqual([]);
  });

  it("a user prompt inside the settle window cancels the dispatch; omp-ui's own prompt does not", async () => {
    const { tracker, dispatches, stalledTurn } = setup();
    stalledTurn();
    tracker.onSend(TAB, { type: "prompt", message: "carry on" });
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toEqual([]);

    stalledTurn();
    tracker.onSend(TAB, { type: "prompt", id: "omp-ui-stall-1", message: STALL_CONTINUE_LEAD });
    tracker.onSend(TAB, { type: "abort" });
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toEqual([TAB]);
  });

  it("the cap raises stall-paused attention once and a user prompt lowers it", async () => {
    const { tracker, dispatches, notices, paused, stalledTurn } = setup();
    for (let i = 0; i < STALL_CONTINUE_MAX; i += 1) {
      stalledTurn();
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    }
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX);
    expect(paused).toEqual([]);

    stalledTurn();
    stalledTurn();
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX);
    expect(paused).toEqual([[TAB, true]]);
    expect(notices.filter((n) => n.text === STALL_CONTINUE_CAP_NOTICE)).toHaveLength(1);

    tracker.onSend(TAB, { type: "prompt", message: "again" });
    expect(paused).toEqual([[TAB, true], [TAB, false]]);
    stalledTurn();
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toHaveLength(STALL_CONTINUE_MAX + 1);
  });

  it("exit cancels a pending dispatch and lowers a paused level", async () => {
    const { tracker, dispatches, paused, stalledTurn } = setup();
    stalledTurn();
    tracker.onExit(TAB);
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    expect(dispatches).toEqual([]);

    for (let i = 0; i <= STALL_CONTINUE_MAX; i += 1) {
      stalledTurn();
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    }
    expect(paused).toEqual([[TAB, true]]);
    tracker.dispose(TAB);
    expect(paused).toEqual([[TAB, true], [TAB, false]]);
  });

  it("does not dispatch when the tab is no longer continuable at fire time", async () => {
    const { dispatches, state, stalledTurn } = setup();
    stalledTurn();
    state.continuable = false;
    await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    expect(dispatches).toEqual([]);
  });
});
