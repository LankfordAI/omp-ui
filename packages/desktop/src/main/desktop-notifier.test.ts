import { CH } from "@omp-ui/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotifier, NOTIFICATION_POST_DELAY_MS } from "./desktop-notifier";

const TAB = "tab-notify";

interface FakeNotification {
  options: { title: string; body: string; icon?: string; silent?: boolean };
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

function setup(isRoutineTab?: (tabId: string) => boolean, soundGate?: () => Promise<boolean>) {
  const win = makeWin();
  const flags = {
    enabled: true,
    viewedTab: null as string | null,
    title: "My session",
    icon: "/icons/app.png" as string | null,
    sounds: true,
  };
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const cues: string[] = [];
  const notifier = new DesktopNotifier({
    win: win as never,
    isEnabled: () => flags.enabled,
    isViewedByDesktop: (tabId) => flags.viewedTab === tabId,
    titleOf: () => flags.title,
    icon: () => flags.icon,
    send: (channel, ...args) => sent.push({ channel, args }),
    sendDesktop: (channel, ...args) => cues.push(`${channel}:${String(args[0])}`),
    isSoundsEnabled: () => flags.sounds,
    ...(soundGate !== undefined ? { soundGate } : {}),
    ...(isRoutineTab ? { isRoutineTab } : {}),
  });
  return { notifier, win, flags, sent, cues };
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
      silent: true,
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

  it("notifyNow posts immediately with an explicit title and focuses on click", () => {
    const { notifier, win, sent } = setup();
    expect(notifier.notifyNow(TAB, "Ship it", "deploy done")).toBe("posted");
    // No attention delay: the notification is up before any timer runs.
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]!.options).toEqual({
      title: "Ship it",
      body: "deploy done",
      icon: "/icons/app.png",
      silent: true,
    });
    state.instances[0]!.clickHandlers[0]!();
    expect(win.focuses).toBe(1);
    expect(sent).toEqual([{ channel: CH.onFocusSession, args: [TAB] }]);
  });

  it("notifyNow falls back to the session title and honors the master switch", () => {
    const { notifier, flags } = setup();
    expect(notifier.notifyNow(TAB, null, "hi")).toBe("posted");
    expect(state.instances[0]!.options.title).toBe("My session");
    flags.enabled = false;
    expect(notifier.notifyNow(TAB, null, "hi")).toBe("notifications are disabled in Settings");
    expect(state.instances).toHaveLength(1);
  });

  it("notifyNow reports a show failure once per kind", () => {
    const { notifier } = setup();
    state.showError = new Error("dbus gone");
    expect(notifier.notifyNow(TAB, null, "a")).toBe("the desktop refused to show the notification");
    expect(notifier.notifyNow(TAB, null, "b")).toBe("the desktop refused to show the notification");
    expect(console.warn).toHaveBeenCalledTimes(1);
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

  describe("notification sound cues", () => {
    it("maps each attention state to its cue and posts it to the desktop window only", async () => {
      const { notifier, sent, cues } = setup();
      notifier.turnEnded(TAB);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      expect(cues).toEqual([`${CH.onNotificationCue}:turn`]);

      notifier.planProposed("tab-b", "A plan");
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      notifier.projectRequested("tab-c");
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      notifier.grantRaiseRequested("tab-e");
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      expect(cues).toEqual([`${CH.onNotificationCue}:turn`, `${CH.onNotificationCue}:plan`, `${CH.onNotificationCue}:plan`, `${CH.onNotificationCue}:plan`]);

      notifier.stallCap("tab-d", true);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      expect(cues[4]).toBe(`${CH.onNotificationCue}:alert`);

      // The cue goes through sendDesktop only — the fan-out sinks (remote web
      // clients) never see it.
      expect(sent.filter((s) => s.channel === CH.onNotificationCue)).toHaveLength(0);
    });

    it("notifyNow plays the alert cue after the banner shows", () => {
      const { notifier, cues } = setup();
      expect(notifier.notifyNow(TAB, null, "ping")).toBe("posted");
      expect(cues).toEqual([`${CH.onNotificationCue}:alert`]);
    });

    it("routine payloads cue plan for approvals and alert otherwise", () => {
      const { notifier, cues } = setup();
      notifier.notifyRoutine({ routineId: "r1", tabId: TAB, title: "Morning", body: "Approval needed: bash", cue: "plan" });
      notifier.notifyRoutine({ routineId: "r1", tabId: null, title: "Morning", body: "Failed — error" });
      expect(cues).toEqual([`${CH.onNotificationCue}:plan`, `${CH.onNotificationCue}:alert`]);
    });

    it("a suppressed post never cues, and sounds-off stops both the cue and keeps silent false", async () => {
      const { notifier, flags, cues } = setup();
      notifier.turnEnded(TAB);
      notifier.viewedChanged(TAB);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      expect(state.instances).toHaveLength(0);
      expect(cues).toEqual([]);

      flags.sounds = false;
      notifier.turnEnded(TAB);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      expect(state.instances).toHaveLength(1);
      expect(state.instances[0]!.options.silent).toBe(false);
      expect(cues).toEqual([]);
    });

    it("the GNOME gate holds the cue until it answers and blocks playback when muted", async () => {
      let resolveGate: ((allowed: boolean) => void) | null = null;
      const { notifier, cues } = setup(undefined, () => new Promise<boolean>((resolve) => { resolveGate = resolve; }));
      notifier.turnEnded(TAB);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      // The banner posted; the cue waits on the gate.
      expect(state.instances).toHaveLength(1);
      expect(cues).toEqual([]);
      resolveGate!(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(cues).toEqual([]);

      notifier.turnEnded("tab-b");
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      // A fresh notifier with an allowing gate plays.
      const gate2 = setup(undefined, async () => true);
      gate2.notifier.turnEnded("tab-x");
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(gate2.cues).toEqual([`${CH.onNotificationCue}:turn`]);
    });

    it("a rejecting gate allows playback", async () => {
      const { notifier, cues } = setup(undefined, () => Promise.reject(new Error("gsettings missing")));
      notifier.turnEnded(TAB);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(cues).toEqual([`${CH.onNotificationCue}:turn`]);
    });
  });

  describe("snooze return", () => {
    it("posts a single-session banner with the session title, cues snooze, and click focuses it", () => {
      const { notifier, win, sent, cues } = setup();
      notifier.notifySnoozeReturn([TAB]);
      expect(state.instances).toHaveLength(1);
      expect(state.instances[0]!.options).toEqual({
        title: "My session",
        body: "Snooze ended — click to resume",
        icon: "/icons/app.png",
        silent: true,
      });
      expect(cues).toEqual([`${CH.onNotificationCue}:snooze`]);
      state.instances[0]!.clickHandlers[0]!();
      expect(win.focuses).toBe(1);
      expect(sent).toEqual([{ channel: CH.onFocusSession, args: [TAB] }]);
      // viewedChanged dismisses the tracked snooze banner.
      notifier.viewedChanged(TAB);
      expect(state.instances[0]!.closed).toBe(1);
    });

    it("posts per-session banners for 2 due sessions and coalesces 3+ into one count banner", () => {
      const { notifier, win, sent, cues } = setup();
      notifier.notifySnoozeReturn(["tab-a", "tab-b"]);
      expect(state.instances).toHaveLength(2);
      expect(cues).toEqual([`${CH.onNotificationCue}:snooze`]);

      notifier.notifySnoozeReturn(["tab-a", "tab-b", "tab-c"]);
      expect(state.instances).toHaveLength(3);
      expect(state.instances[2]!.options).toEqual({
        title: "omp-ui",
        body: "3 snoozed sessions are due",
        icon: "/icons/app.png",
        silent: true,
      });
      expect(cues).toEqual([`${CH.onNotificationCue}:snooze`, `${CH.onNotificationCue}:snooze`]);
      state.instances[2]!.clickHandlers[0]!();
      expect(win.focuses).toBe(1);
      expect(sent).toEqual([]);
    });

    it("suppresses snooze banners when the desktop window is focused", () => {
      const { notifier, win, cues } = setup();
      win.focused = true;
      notifier.notifySnoozeReturn([TAB]);
      notifier.notifySnoozeReturn([TAB, "tab-b", "tab-c"]);
      expect(state.instances).toHaveLength(0);
      expect(cues).toEqual([]);
    });

    it("honors the master switch, the empty wake list, and sounds-off silent semantics", () => {
      const { notifier, flags, cues } = setup();
      notifier.notifySnoozeReturn([]);
      expect(state.instances).toHaveLength(0);

      flags.enabled = false;
      notifier.notifySnoozeReturn([TAB]);
      expect(state.instances).toHaveLength(0);
      expect(cues).toEqual([]);

      flags.enabled = true;
      flags.sounds = false;
      notifier.notifySnoozeReturn([TAB]);
      expect(state.instances[0]!.options.silent).toBe(false);
      expect(cues).toEqual([]);
    });

    it("yields to a muting GNOME gate", async () => {
      const { notifier, cues } = setup(undefined, async () => false);
      notifier.notifySnoozeReturn([TAB]);
      expect(state.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(cues).toEqual([]);
    });
  });
  describe("routine notifications (#1294)", () => {
    it("suppresses generic turnEnded on routine tabs", async () => {
      const { notifier } = setup((tabId) => tabId === TAB);
      notifier.turnEnded(TAB);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POST_DELAY_MS + 100);
      expect(state.instances).toHaveLength(0);
    });

    it("notifyRoutine posts immediately, replaces per run, survives sessionExit, and dismisses on viewed/clearRoutine/dispose", () => {
      const { notifier, win, sent } = setup((tabId) => tabId === TAB);
      notifier.notifyRoutine({ routineId: "r1", tabId: TAB, title: "Morning", body: "Routine started" });
      expect(state.instances).toHaveLength(1);
      expect(state.instances[0]!.options).toEqual({ title: "Morning", body: "Routine started", icon: "/icons/app.png", silent: true });

      // Second banner for same run replaces the first.
      notifier.notifyRoutine({ routineId: "r1", tabId: TAB, title: "Morning", body: "Completed" });
      expect(state.instances).toHaveLength(2);
      expect(state.instances[0]!.closed).toBe(1);
      expect(state.instances[1]!.shown).toBe(1);

      // Survives 60 s self-settle exit.
      notifier.sessionExit(TAB);
      expect(state.instances[1]!.closed).toBe(0);

      // Click focuses session when tabId != null.
      state.instances[1]!.clickHandlers[0]!();
      expect(win.focuses).toBe(1);
      expect(sent).toEqual([{ channel: CH.onFocusSession, args: [TAB] }]);

      // viewedChanged dismisses it.
      notifier.viewedChanged(TAB);
      expect(state.instances[1]!.closed).toBe(1);

      // clearRoutine dismisses an active banner; dispose closes remaining ones.
      notifier.notifyRoutine({ routineId: "r1", tabId: TAB, title: "Morning", body: "Approval needed: bash" });
      notifier.clearRoutine(TAB);
      expect(state.instances[2]!.closed).toBe(1);

      notifier.notifyRoutine({ routineId: "r1", tabId: null, title: "Morning", body: "Failed — Pre-run script failed" });
      notifier.dispose();
      expect(state.instances[3]!.closed).toBe(1);
    });

    it("notifyRoutine suppresses when focused+viewed for a run tab and click-focuses routine for pre-spawn failures", () => {
      const { notifier, win, flags, sent } = setup((tabId) => tabId === TAB);
      win.focused = true;
      flags.viewedTab = TAB;
      notifier.notifyRoutine({ routineId: "r1", tabId: TAB, title: "Morning", body: "Completed" });
      expect(state.instances).toHaveLength(0);

      // Pre-spawn failure (tabId: null) still posts and click focuses the routine.
      notifier.notifyRoutine({ routineId: "r1", tabId: null, title: "Morning", body: "Failed — Could not start session" });
      expect(state.instances).toHaveLength(1);
      state.instances[0]!.clickHandlers[0]!();
      expect(sent).toEqual([{ channel: CH.onFocusRoutine, args: ["r1"] }]);
    });

    it("notifyNow closes an earlier routine banner for the same tab and tracks routine tabs for viewedChanged/dispose", () => {
      const { notifier } = setup((tabId) => tabId === TAB);
      notifier.notifyRoutine({ routineId: "r1", tabId: TAB, title: "Morning", body: "Routine started" });
      expect(notifier.notifyNow(TAB, "Morning", "All checks passed.")).toBe("posted");
      expect(state.instances).toHaveLength(2);
      expect(state.instances[0]!.closed).toBe(1);
      expect(state.instances[1]!.shown).toBe(1);

      // Survives sessionExit and closes on viewedChanged.
      notifier.sessionExit(TAB);
      expect(state.instances[1]!.closed).toBe(0);
      notifier.viewedChanged(TAB);
      expect(state.instances[1]!.closed).toBe(1);
    });
  });
});
