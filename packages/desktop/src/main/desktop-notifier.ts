import { Notification, type BrowserWindow } from "electron";
import { CH, type NotificationCue } from "@omp-ui/core";
import type { GnomeSoundGate } from "./gnome-sound-gate";

/**
 * Posts OS notifications for owned native sessions that reach an attention
 * state while the user is not looking at them (issue #271): a turn finished,
 * a plan review is pending, or stall auto-continue paused at its cap.
 *
 * The state is per tab — one notification, replaced rather than stacked.
 * Every post is delayed (NOTIFICATION_POST_DELAY_MS) and re-gated at fire
 * time: the delay absorbs the stall auto-continue settle window (1.5 s), so
 * a turn that auto-resumes never blinks a "finished" banner, and the gate
 * reads live state at the moment the user would see the banner.
 */

export type AttentionKind = "turn-complete" | "plan-pending" | "stall-paused" | "project-request";

export interface RoutineNotificationPayload {
  routineId: string;
  tabId: string | null;
  title: string;
  body: string;
  /** Cue for this lifecycle event; omitted means "alert". Approval cards use "plan". */
  cue?: NotificationCue;
}

/** The frame-derived attention transitions SessionManager reports. */
export interface Attention {
  /** A turn started on this tab: activity answers every pending attention. */
  turnStarted(tabId: string): void;
  /** The last running turn ended and the session is idle (no gate/dialog pending). */
  turnEnded(tabId: string): void;
  /** A plan proposal was recorded as the tab's pending gate. */
  planProposed(tabId: string, planTitle: string): void;
  /** A verdict closed the tab's plan gate. */
  planSettled(tabId: string): void;
  /** An agent's project request card opened on this tab (#1228). */
  projectRequested(tabId: string): void;
  /** The tab's project request settled (answer, cancel, exit). */
  projectRequestSettled(tabId: string): void;
  /**
   * The desktop renderer's viewed-tab report named this tab: the user is
   * looking at it, so its attention is acknowledged.
   */
  viewedChanged(tabId: string): void;
  /** The tab's live process left `live` (exit, terminate, hibernation reap). */
  sessionExit(tabId: string): void;
}

export interface DesktopNotifierDeps {
  win: BrowserWindow;
  /** The Settings → General switch (re-read at every fire). */
  isEnabled: () => boolean;
  /** True while the desktop renderer's fresh viewed report names the tab (issue #271). */
  isViewedByDesktop: (tabId: string) => boolean;
  /** The sidebar's session title for the tab. */
  titleOf: (tabId: string) => string;
  /** OS notification icon path, or null when absent. */
  icon: () => string | null;
  /** Fans the notification-click event out to every renderer sink. */
  send: (channel: string, ...args: unknown[]) => void;
  /** Delivers an event to this app's Electron window only — never a remote web client. */
  sendDesktop: (channel: string, ...args: unknown[]) => void;
  /** The Settings → General sound switch (re-read at every fire). */
  isSoundsEnabled: () => boolean;
  /** GNOME DND / per-app sound mute check; absent or resolving true allows the cue. */
  soundGate?: GnomeSoundGate;
  /** True when the tab belongs to a Routine run (#1294). */
  isRoutineTab?: (tabId: string) => boolean;
}

interface TabAttention {
  kind: AttentionKind;
  planTitle: string | null;
  notification: Notification | null;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Post delay. Must stay above STALL_CONTINUE_SETTLE_MS (1500 ms) so a
 * stall-continue prompt — dispatched by the renderer ~1.5 s after a stall
 * end — starts its turn and cancels the pending post before it can fire.
 */
export const NOTIFICATION_POST_DELAY_MS = 3_000;
/** OS notification body copy. The title stays the session's sidebar title
    (session content). {title} is the plan's own title (agent-authored data),
    substituted verbatim. */
const COPY = {
  turnComplete: "Turn finished",
  planPending: "Plan review: {title}",
  planPendingNoTitle: "Plan review — answer needed",
  stallPaused: "Stall auto-continue paused — send a prompt to re-arm",
  projectRequest: "Project request — answer needed",
  snoozeReturned: "Snooze ended — click to resume",
} as const;

export class DesktopNotifier implements Attention {
  private readonly tabs = new Map<string, TabAttention>();
  private readonly routineNotifications = new Map<string, Notification>();
  private readonly snoozeNotifications = new Map<string, Notification>();
  private warnedUnsupported = false;
  private warnedShowFailure = false;

  constructor(private readonly deps: DesktopNotifierDeps) {}

  // --- Attention (SessionManager hooks) ---------------------------------

  turnStarted(tabId: string): void {
    this.drop(tabId);
  }

  turnEnded(tabId: string): void {
    if (this.deps.isRoutineTab?.(tabId) === true) return;
    this.schedule(tabId, "turn-complete", null);
  }

  planProposed(tabId: string, planTitle: string): void {
    this.schedule(tabId, "plan-pending", planTitle);
  }

  planSettled(tabId: string): void {
    this.drop(tabId, "plan-pending");
  }

  projectRequested(tabId: string): void {
    this.schedule(tabId, "project-request", null);
  }

  projectRequestSettled(tabId: string): void {
    this.drop(tabId, "project-request");
  }

  viewedChanged(tabId: string): void {
    this.drop(tabId);
    this.clearRoutine(tabId);
    this.clearSnooze(tabId);
  }

  sessionExit(tabId: string): void {
    this.drop(tabId);
  }

  /** The tab's stall auto-continue guard paused at its cap, or re-armed. */
  stallCap(tabId: string, paused: boolean): void {
    if (paused) this.schedule(tabId, "stall-paused", null);
    else this.drop(tabId, "stall-paused");
  }

  /** Clears every timer and closes every notification (app quit). */
  dispose(): void {
    for (const tabId of [...this.tabs.keys()]) this.drop(tabId);
    for (const notification of this.routineNotifications.values()) notification.close();
    this.routineNotifications.clear();
    for (const notification of this.snoozeNotifications.values()) notification.close();
    this.snoozeNotifications.clear();
  }

  // --- routine lifecycle notifications (#1294) ---------------------------

  /**
   * Posts one per-routine OS notification immediately. Replaces any prior
   * banner for the same run (or routine for pre-spawn failures) and survives
   * 60 s self-settle until the run tab is viewed, cleared, or the app quits.
   */
  notifyRoutine(payload: RoutineNotificationPayload): void {
    if (!this.enabled()) return;
    const win = this.deps.win;
    if (
      payload.tabId !== null &&
      !win.isDestroyed() &&
      win.isFocused() &&
      this.deps.isViewedByDesktop(payload.tabId)
    ) {
      return;
    }
    const key = payload.tabId ?? `routine:${payload.routineId}`;
    const prev = this.routineNotifications.get(key);
    if (prev !== undefined) {
      prev.close();
      this.routineNotifications.delete(key);
    }
    let notification: Notification;
    try {
      const icon = this.deps.icon();
      notification = new Notification({
        title: payload.title,
        body: payload.body,
        ...(icon !== null ? { icon } : {}),
        silent: this.deps.isSoundsEnabled(),
      });
    } catch (err) {
      if (!this.warnedShowFailure) {
        this.warnedShowFailure = true;
        console.warn("[notifier] could not create notification:", err);
      }
      return;
    }
    notification.on("click", () => {
      if (payload.tabId !== null) this.focusSession(payload.tabId);
      else this.focusRoutine(payload.routineId);
    });
    try {
      notification.show();
    } catch (err) {
      if (!this.warnedShowFailure) {
        this.warnedShowFailure = true;
        console.warn("[notifier] could not show notification:", err);
      }
      return;
    }
    this.playCue(payload.cue ?? "alert");
    this.routineNotifications.set(key, notification);
  }

  /** Closes any active routine banner for a run tab (viewed or approval closed). */
  clearRoutine(tabId: string): void {
    const prev = this.routineNotifications.get(tabId);
    if (prev === undefined) return;
    prev.close();
    this.routineNotifications.delete(tabId);
  }

  // --- snooze return (#979, #1323) ---------------------------------------

  /** Closes any active snooze-reminder banner for `tabId` (viewed, unsnoozed, re-snoozed, settled). */
  clearSnooze(tabId: string): void {
    const prev = this.snoozeNotifications.get(tabId);
    if (prev === undefined) return;
    prev.close();
    this.snoozeNotifications.delete(tabId);
  }

  /**
   * Timed snoozes whose deadline passed under a live timer (never startup
   * catch-up): skipped when the desktop window is focused (the user is already
   * looking at the Attention stack). 1–2 due sessions post one banner per
   * session; 3+ coalesce into one count banner that focuses the app window.
   */
  notifySnoozeReturn(tabIds: readonly string[]): void {
    if (tabIds.length === 0 || !this.enabled()) return;
    const win = this.deps.win;
    if (!win.isDestroyed() && win.isFocused()) return;
    const postOne = (key: string, title: string, body: string, focusTabId: string | null): boolean => {
      const prev = this.snoozeNotifications.get(key);
      if (prev !== undefined) {
        prev.close();
        this.snoozeNotifications.delete(key);
      }
      let notification: Notification;
      try {
        const icon = this.deps.icon();
        notification = new Notification({
          title,
          body,
          ...(icon !== null ? { icon } : {}),
          silent: this.deps.isSoundsEnabled(),
        });
      } catch (err) {
        if (!this.warnedShowFailure) {
          this.warnedShowFailure = true;
          console.warn("[notifier] could not create notification:", err);
        }
        return false;
      }
      notification.on("click", () => {
        if (focusTabId !== null) this.focusSession(focusTabId);
        else this.focusWindow();
      });
      if (focusTabId !== null) this.clearRoutine(focusTabId);
      try {
        notification.show();
      } catch (err) {
        if (!this.warnedShowFailure) {
          this.warnedShowFailure = true;
          console.warn("[notifier] could not show notification:", err);
        }
        return false;
      }
      this.snoozeNotifications.set(key, notification);
      return true;
    };

    let posted = false;
    if (tabIds.length <= 2) {
      for (const tabId of tabIds) {
        if (postOne(tabId, this.deps.titleOf(tabId), COPY.snoozeReturned, tabId)) posted = true;
      }
    } else {
      for (const tabId of tabIds) this.clearRoutine(tabId);
      posted = postOne("batch", "omp-ui", `${tabIds.length} snoozed sessions are due`, null);
    }
    if (posted) this.playCue("snooze");
  }
  // --- direct post (host tool, issue #688) -------------------------------

  /**
   * Posts one OS notification NOW, outside the attention pipeline: the model
   * asked for this interrupt by name, so the delayed post's suppression rules
   * (focused-and-viewed, turn activity) do not apply — only the Settings
   * switch and platform support do. Returns the text the tool result reports
   * back to the model.
   */
  notifyNow(tabId: string, title: string | null, message: string): string {
    if (!this.enabled()) return "notifications are disabled in Settings";
    let notification: Notification;
    try {
      const icon = this.deps.icon();
      notification = new Notification({
        title: title !== null ? title : this.deps.titleOf(tabId),
        body: message,
        ...(icon !== null ? { icon } : {}),
        silent: this.deps.isSoundsEnabled(),
      });
    } catch (err) {
      if (!this.warnedShowFailure) {
        this.warnedShowFailure = true;
        console.warn("[notifier] could not create notification:", err);
      }
      return "the desktop refused to create the notification";
    }
    notification.on("click", () => this.focusSession(tabId));
    this.clearRoutine(tabId);
    try {
      notification.show();
    } catch (err) {
      if (!this.warnedShowFailure) {
        this.warnedShowFailure = true;
        console.warn("[notifier] could not show notification:", err);
      }
      return "the desktop refused to show the notification";
    }
    this.playCue("alert");
    if (this.deps.isRoutineTab?.(tabId) === true) {
      this.routineNotifications.set(tabId, notification);
    }
    return "posted";
  }

  // --- sound cues --------------------------------------------------------

  /** The attention state's cue: a finished turn chimes softly, anything
      needing an answer steps up, everything else is the attention ping. */
  private static cueFor(kind: AttentionKind): NotificationCue {
    switch (kind) {
      case "turn-complete":
        return "turn";
      case "plan-pending":
      case "project-request":
        return "plan";
      case "stall-paused":
        return "alert";
    }
  }

  /**
   * Asks the Electron desktop renderer to synthesize the cue. Desktop window
   * only — a remote web client is a different screen and stays silent. On
   * GNOME the cue yields to Do-Not-Disturb and the per-app sound mute; the
   * gate check is async so the banner is never delayed behind it, and a
   * missing or failing gate allows playback.
   */
  private playCue(cue: NotificationCue): void {
    if (!this.deps.isSoundsEnabled()) return;
    const post = (): void => {
      if (this.deps.isSoundsEnabled()) this.deps.sendDesktop(CH.onNotificationCue, cue);
    };
    if (this.deps.soundGate === undefined) {
      post();
      return;
    }
    void this.deps.soundGate().then((allowed) => {
      if (allowed) post();
    }, post);
  }

  // --- internals ---------------------------------------------------------

  /**
   * Replaces the tab's pending/active attention. A fresh post supersedes an
   * older one for the same tab; an already-shown notification is closed so a
   * tab never carries two banners.
   */
  private schedule(tabId: string, kind: AttentionKind, planTitle: string | null): void {
    const prev = this.tabs.get(tabId);
    if (prev !== undefined) {
      clearTimeout(prev.timer);
      if (prev.notification !== null) {
        prev.notification.close();
        prev.notification = null;
      }
    }
    if (!this.enabled()) {
      this.tabs.delete(tabId);
      return;
    }
    const timer = setTimeout(() => this.fire(tabId), NOTIFICATION_POST_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.tabs.set(tabId, { kind, planTitle, notification: null, timer });
  }

  /** Closes the tab's attention; a kind limits the drop to that state. */
  private drop(tabId: string, kind: AttentionKind | null = null): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) return;
    if (kind !== null && entry.kind !== kind) return;
    clearTimeout(entry.timer);
    if (entry.notification !== null) entry.notification.close();
    this.tabs.delete(tabId);
  }

  /** Settings switch plus platform support, re-read at post time. */
  private enabled(): boolean {
    if (!this.deps.isEnabled()) return false;
    // Main-process tests may mock electron without Notification; Vitest throws
    // on accessing an unexported key on a partial module mock, so guard it.
    let supported: boolean;
    try {
      supported = typeof Notification === "function" && Notification.isSupported();
    } catch {
      supported = false;
    }
    if (!supported) {
      if (!this.warnedUnsupported) {
        this.warnedUnsupported = true;
        console.warn("[notifier] desktop notifications unsupported on this platform");
      }
      return false;
    }
    return true;
  }

  /** The delayed post: re-gates on live state, then shows (replacing) the banner. */
  private fire(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined || entry.timer === undefined) return;
    entry.timer = undefined;
    const win = this.deps.win;
    // Suppressed only while the desktop window is focused AND showing this
    // tab. A turn that finishes while the user works a different tab is
    // exactly the case this feature exists for (issue #271); remote
    // renderers' viewed tabs never count — they are a different screen.
    if (
      !this.enabled() ||
      win.isDestroyed() ||
      (win.isFocused() && this.deps.isViewedByDesktop(tabId))
    ) {
      this.tabs.delete(tabId);
      return;
    }
    let notification: Notification;
    try {
      const { title, body } = this.copyFor(tabId, entry);
      const icon = this.deps.icon();
      notification = new Notification({
        title,
        body,
        ...(icon !== null ? { icon } : {}),
        silent: this.deps.isSoundsEnabled(),
      });
    } catch (err) {
      if (!this.warnedShowFailure) {
        this.warnedShowFailure = true;
        console.warn("[notifier] could not create notification:", err);
      }
      this.tabs.delete(tabId);
      return;
    }
    notification.on("click", () => this.focusSession(tabId));
    try {
      notification.show();
    } catch (err) {
      if (!this.warnedShowFailure) {
        this.warnedShowFailure = true;
        console.warn("[notifier] could not show notification:", err);
      }
      this.tabs.delete(tabId);
      return;
    }
    this.playCue(DesktopNotifier.cueFor(entry.kind));
    entry.notification = notification;
  }

  /** Notification copy: the session's sidebar title, the state as body. */
  private copyFor(tabId: string, entry: TabAttention): { title: string; body: string } {
    const title = this.deps.titleOf(tabId);
    switch (entry.kind) {
      case "turn-complete":
        return { title, body: COPY.turnComplete };
      case "plan-pending":
        return {
          title,
          body:
            entry.planTitle !== null && entry.planTitle.trim() !== ""
              ? COPY.planPending.replace("{title}", entry.planTitle)
              : COPY.planPendingNoTitle,
        };
      case "stall-paused":
        return { title, body: COPY.stallPaused };
      case "project-request":
        return { title, body: COPY.projectRequest };
    }
  }

  /**
   * Click handler: bring the window forward (restore if minimized, show if
   * macOS-hidden) and fan the focus event to every renderer; each resurfaces
   * (or resumes) the tab through the ordinary openSession path.
   */
  private focusWindow(): void {
    const win = this.deps.win;
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  private focusSession(tabId: string): void {
    const win = this.deps.win;
    if (win.isDestroyed()) return;
    this.focusWindow();
    this.deps.send(CH.onFocusSession, tabId);
  }
  private focusRoutine(routineId: string): void {
    const win = this.deps.win;
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.deps.send(CH.onFocusRoutine, routineId);
  }
}
