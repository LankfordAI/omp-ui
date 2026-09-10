import type { Attention } from "@omp-ui/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotifier, NOTIFICATION_POST_DELAY_MS } from "./desktop-notifier";

const TAB = "tab-notify";
/** The notifier's construction instant; levels stamped later are "raised since". */
const SUBSCRIBED_AT = 10_000;
let stamp = SUBSCRIBED_AT;
const level = (kind: Attention["kind"], planTitle: string | null = null): Attention => ({
  kind,
  planTitle,
  atMs: ++stamp,
});

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
    title: "My session",
    icon: "/icons/app.png" as string | null,
    locale: "en",
  };
  const surfaced: string[] = [];
  const notifier = new DesktopNotifier({
    win: win as never,
    isEnabled: () => flags.enabled,
    titleOf: () => flags.title,
    localeId: () => flags.locale,
    icon: () => flags.icon,
    surfaceTab: (tabId) => surfaced.push(tabId),
    now: () => SUBSCRIBED_AT,
  });
  return { notifier, win, flags, surfaced };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.supported = true;
  state.ctorError = null;
  state.showError = null;
  state.instances.length = 0;
  stamp = SUBSCRIBED_AT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DesktopNotifier", () => {
  it("posts a Turn finished banner after the delay, with the session's title", async () => {
    const { notifier } = setup();
    notifier.onAttention(TAB, level("turn-complete"));

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

  it("posts while the window is focused when this client views a different tab (issue #271)", async () => {
    const { notifier, win } = setup();
    win.focused = true;
    notifier.clientViewed("other-tab");

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.shown).toBe(1);
  });

  it("suppressed when the focused window's own client is viewing this tab", async () => {
    const { notifier, win } = setup();
    win.focused = true;
    notifier.clientViewed(TAB);

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("posts when the window is unfocused even if the tab is viewed in the window", async () => {
    const { notifier } = setup();
    notifier.clientViewed(TAB);

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
  });

  it("no post when the settings switch is off", async () => {
    const { notifier, flags } = setup();
    flags.enabled = false;

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("no post when unsupported, warning once", async () => {
    const { notifier } = setup();
    state.supported = false;

    notifier.onAttention(TAB, level("turn-complete"));
    notifier.onAttention("tab-b", level("turn-complete"));
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

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("re-reads the switch at fire: flipped off during the delay, nothing posts", async () => {
    const { notifier, flags } = setup();
    notifier.onAttention(TAB, level("turn-complete"));
    flags.enabled = false;

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("re-reads the view at fire: the focused window showing the tab during the delay, nothing posts", async () => {
    const { notifier, win } = setup();
    notifier.onAttention(TAB, level("turn-complete"));
    win.focused = true;
    notifier.clientViewed(TAB);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
  });

  it("a plan-pending level within the window replaces the pending turn-complete post", async () => {
    const { notifier } = setup();
    notifier.onAttention(TAB, level("turn-complete"));
    notifier.onAttention(TAB, level("plan-pending", "Fix the billing bug"));

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.options.body).toBe("Plan review: Fix the billing bug");
  });

  it("a blank plan title falls back to the answer-needed body", async () => {
    const { notifier } = setup();
    notifier.onAttention(TAB, level("plan-pending", "   "));

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances[0]!.options.body).toBe("Plan review — answer needed");
  });

  it("stall-paused posts the paused body", async () => {
    const { notifier } = setup();
    notifier.onAttention(TAB, level("stall-paused"));

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances[0]!.options.body).toBe(
      "Stall auto-continue paused — send a prompt to re-arm",
    );
  });

  it("ko locale: turn-complete posts the Korean body with the session title verbatim", async () => {
    const { notifier, flags } = setup();
    flags.locale = "ko";

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances[0]!.options).toEqual({
      title: "My session",
      body: "턴이 끝났습니다",
      icon: "/icons/app.png",
    });
  });

  it("ko locale: a non-blank plan title is interpolated into the Korean body", async () => {
    const { notifier, flags } = setup();
    flags.locale = "ko";

    notifier.onAttention(TAB, level("plan-pending", "Fix the billing bug"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances[0]!.options.body).toBe("플랜 검토: Fix the billing bug");
  });

  it("ko locale: a blank plan title falls back to the no-title body", async () => {
    const { notifier, flags } = setup();
    flags.locale = "ko";

    notifier.onAttention(TAB, level("plan-pending", "   "));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances[0]!.options.body).toBe("플랜 검토 — 응답 필요");
  });

  it("a null level drops a pending post and closes a shown banner", async () => {
    const { notifier } = setup();

    notifier.onAttention(TAB, level("turn-complete"));
    notifier.onAttention(TAB, null);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    notifier.onAttention(TAB, level("plan-pending", "A plan"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances[0]!.shown).toBe(1);
    notifier.onAttention(TAB, null);
    expect(state.instances[0]!.closed).toBe(1);
  });

  it("the same host stamp twice never re-banners; a fresh stamp does", async () => {
    const { notifier } = setup();
    const first = level("turn-complete");

    notifier.onAttention(TAB, first);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(1);

    // A replayed summary carries the same level again (state:changed, reconnect).
    notifier.onAttention(TAB, { ...first });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.closed).toBe(0);

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(2);
    expect(state.instances[0]!.closed).toBe(1);
  });

  it("a level already in place at subscription is recorded, never announced", async () => {
    const { notifier } = setup();
    const stale: Attention = { kind: "turn-complete", planTitle: null, atMs: SUBSCRIBED_AT };

    notifier.onAttention(TAB, stale);
    notifier.onAttention("tab-old", { kind: "plan-pending", planTitle: "p", atMs: SUBSCRIBED_AT - 5_000 });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    // Replaying that same stale level later is still nothing; a newer one posts.
    notifier.onAttention(TAB, { ...stale });
    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(1);
  });

  it("a second level closes the previously shown notification (replace, never stack)", async () => {
    const { notifier } = setup();
    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances[0]!.shown).toBe(1);

    notifier.onAttention(TAB, level("plan-pending", "A plan"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(2);
    expect(state.instances[0]!.closed).toBe(1);
    expect(state.instances[1]!.shown).toBe(1);
  });

  it("click restores a minimized window, shows, focuses, and surfaces the tab once", async () => {
    const { notifier, win, surfaced } = setup();
    win.minimized = true;
    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    state.instances[0]!.clickHandlers[0]!();

    expect(win.restores).toBe(1);
    expect(win.shows).toBe(1);
    expect(win.focuses).toBe(1);
    expect(surfaced).toEqual([TAB]);
  });

  it("click does not restore an un-minimized window", async () => {
    const { notifier, win } = setup();
    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    state.instances[0]!.clickHandlers[0]!();

    expect(win.restores).toBe(0);
    expect(win.shows).toBe(1);
    expect(win.focuses).toBe(1);
  });

  it("a constructor failure clears the entry and warns once", async () => {
    const { notifier } = setup();
    state.ctorError = new Error("no notification daemon");

    notifier.onAttention(TAB, level("turn-complete"));
    notifier.onAttention("tab-b", level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("a show() failure clears the entry and warns once", async () => {
    const { notifier } = setup();
    state.showError = new Error("d-bus is gone");

    notifier.onAttention(TAB, level("turn-complete"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.shown).toBe(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending post and closes a shown notification", async () => {
    const { notifier } = setup();

    notifier.onAttention(TAB, level("turn-complete"));
    notifier.dispose();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances).toHaveLength(0);

    notifier.onAttention(TAB, level("plan-pending", "A plan"));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
    expect(state.instances[0]!.shown).toBe(1);
    notifier.dispose();
    expect(state.instances[0]!.closed).toBe(1);
  });
});
