import { CH } from "@omp-ui/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotifier, NOTIFICATION_POST_DELAY_MS } from "./desktop-notifier";

const TAB = "tab-notify";

interface FakeNotification {
  options: { title: string; body: string; icon?: string };
  shown: number;
  closed: number;
  clickHandlers: Array<() => void>;
  on(event: "click", cb: () => void): void;
  show(): void;
  close(): void;
}

const state = vi.hoisted(() => ({
  supported: true,
  ctorError: null as unknown,
  showError: null as unknown,
  instances: [] as FakeNotification[],
}));

vi.mock("electron", () => {
  class Notification {
    options: FakeNotification["options"];
    shown = 0;
    closed = 0;
    clickHandlers: Array<() => void> = [];
    static isSupported(): boolean {
      return state.supported;
    }
    constructor(options: FakeNotification["options"]) {
      if (state.ctorError !== null) throw state.ctorError;
      this.options = options;
      state.instances.push(this);
    }
    on(event: "click", cb: () => void): void {
      if (event === "click") this.clickHandlers.push(cb);
    }
    show(): void {
      if (state.showError !== null) throw state.showError;
      this.shown += 1;
    }
    close(): void {
      this.closed += 1;
    }
  }
  return { Notification };
});

function makeWin() {
  const win = {
    destroyed: false,
    minimized: false,
    focused: false,
    restores: 0,
    shows: 0,
    focuses: 0,
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    isFocused: () => win.focused,
    restore: () => {
      win.restores += 1;
    },
    show: () => {
      win.shows += 1;
    },
    focus: () => {
      win.focuses += 1;
    },
  };
  return win;
}

function setup() {
  const win = makeWin();
  const flags = {
    enabled: true,
    viewedTab: null as string | null,
    title: "My session",
    icon: "/icons/app.png" as string | null,
  };
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const notifier = new DesktopNotifier({
    win: win as never,
    isEnabled: () => flags.enabled,
    isViewedByDesktop: (tabId) => flags.viewedTab === tabId,
    titleOf: () => flags.title,
    icon: () => flags.icon,
    send: (channel, ...args) => sent.push({ channel, args }),
  });
  return { notifier, win, flags, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.supported = true;
  state.ctorError = null;
  state.showError = null;
  state.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DesktopNotifier", () => {
  it("posts a Turn finished banner after the delay, with the session's title", async () => {
    const { notifier } = setup();
    notifier.turnEnded(TAB);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS - 1);
    expect(state.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.instances).toHaveLength(1);
    const n = state.instances[0]!;
    expect(n.shown).toBe(1);
    expect(n.options).toEqual({
      title: "My session",
      body: "Turn finished",
      icon: "/icons/app.png",
    });
  });

  it("posts while the window is focused when a different tab is in view (issue #271)", async () => {
    const { notifier, win, flags } = setup();
    win.focused = true;
    flags.viewedTab = "other-tab";

    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.shown).toBe(1);
  });

  it("suppressed when the focused window is showing this tab", async () => {
    const { notifier, win, flags } = setup();
    win.focused = true;
    flags.viewedTab = TAB;

    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("posts when the window is unfocused even if the tab is viewed in the window", async () => {
    const { notifier, flags } = setup();
    flags.viewedTab = TAB;

    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
  });

  it("no post when the settings switch is off", async () => {
    const { notifier, flags } = setup();
    flags.enabled = false;

    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("no post when unsupported, warning once", async () => {
    const { notifier } = setup();
    state.supported = false;

    notifier.turnEnded(TAB);
    notifier.turnEnded("tab-b");
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[notifier] desktop notifications unsupported on this platform",
    );
  });

  it("no post when the window is destroyed", async () => {
    const { notifier, win } = setup();
    win.destroyed = true;

    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("re-reads the switch at fire: flipped off during the delay, nothing posts", async () => {
    const { notifier, flags } = setup();
    notifier.turnEnded(TAB);
    flags.enabled = false;

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("re-reads the view at fire: the focused window showing the tab during the delay, nothing posts", async () => {
    const { notifier, win, flags } = setup();
    notifier.turnEnded(TAB);
    win.focused = true;
    flags.viewedTab = TAB;

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("planProposed within the window replaces the pending turn-complete post", async () => {
    const { notifier } = setup();
    notifier.turnEnded(TAB);
    notifier.planProposed(TAB, "Fix the billing bug");

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.options.body).toBe("Plan review: Fix the billing bug");
  });

  it("a blank plan title falls back to the answer-needed body", async () => {
    const { notifier } = setup();
    notifier.planProposed(TAB, "   ");

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances[0]!.options.body).toBe("Plan review — answer needed");
  });

  it("stallCap(true) posts the paused body; stallCap(false) drops only stall-paused", async () => {
    const { notifier } = setup();

    notifier.stallCap(TAB, true);
    notifier.stallCap(TAB, false);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    // A turn-complete that replaces the paused state survives the false report.
    notifier.stallCap(TAB, true);
    notifier.turnEnded(TAB);
    notifier.stallCap(TAB, false);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.options.body).toBe("Turn finished");
  });

  it("planSettled drops only a plan-pending entry", async () => {
    const { notifier } = setup();

    notifier.planProposed(TAB, "A plan");
    notifier.planSettled(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    notifier.planProposed(TAB, "A plan");
    notifier.planSettled(TAB);
    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.options.body).toBe("Turn finished");
  });

  it("turnStarted and sessionExit drop unconditionally; viewedChanged drops the named tab", async () => {
    const { notifier } = setup();

    notifier.turnEnded(TAB);
    notifier.turnStarted(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    notifier.planProposed(TAB, "A plan");
    notifier.sessionExit(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    notifier.turnEnded(TAB);
    notifier.viewedChanged(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);
  });

  it("a second schedule closes the previously shown notification (replace, never stack)", async () => {
    const { notifier } = setup();
    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances[0]!.shown).toBe(1);

    notifier.planProposed(TAB, "A plan");
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(2);
    expect(state.instances[0]!.closed).toBe(1);
    expect(state.instances[1]!.shown).toBe(1);
  });

  it("click restores a minimized window, shows, focuses, and fans the focus event", async () => {
    const { notifier, win, sent } = setup();
    win.minimized = true;
    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    state.instances[0]!.clickHandlers[0]!();

    expect(win.restores).toBe(1);
    expect(win.shows).toBe(1);
    expect(win.focuses).toBe(1);
    expect(sent).toEqual([{ channel: CH.onFocusSession, args: [TAB] }]);
  });

  it("click does not restore an un-minimized window", async () => {
    const { notifier, win } = setup();
    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    state.instances[0]!.clickHandlers[0]!();

    expect(win.restores).toBe(0);
    expect(win.shows).toBe(1);
    expect(win.focuses).toBe(1);
  });

  it("a constructor failure clears the entry and warns once", async () => {
    const { notifier } = setup();
    state.ctorError = new Error("no notification daemon");

    notifier.turnEnded(TAB);
    notifier.turnEnded("tab-b");
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("a show() failure clears the entry and warns once", async () => {
    const { notifier } = setup();
    state.showError = new Error("d-bus is gone");

    notifier.turnEnded(TAB);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.shown).toBe(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending post and closes a shown notification", async () => {
    const { notifier } = setup();

    notifier.turnEnded(TAB);
    notifier.dispose();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    notifier.planProposed(TAB, "A plan");
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances[0]!.shown).toBe(1);
    notifier.dispose();
    expect(state.instances[0]!.closed).toBe(1);
  });
});
