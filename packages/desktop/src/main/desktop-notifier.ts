import { Notification, type BrowserWindow } from "electron";
import { CH } from "@omp-ui/core";

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

export type AttentionKind = "turn-complete" | "plan-pending" | "stall-paused";

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
  /** The registry's localeId (re-read at every fire). */
  localeId: () => string;
  /** True while the desktop renderer's fresh viewed report names the tab (issue #271). */
  isViewedByDesktop: (tabId: string) => boolean;
  /** The sidebar's session title for the tab. */
  titleOf: (tabId: string) => string;
  /** OS notification icon path, or null when absent. */
  icon: () => string | null;
  /** Fans the notification-click event out to every renderer sink. */
  send: (channel: string, ...args: unknown[]) => void;
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
/** OS notification body copy, keyed by locale. The title stays the session's
    sidebar title (session content — never localized). {title} is the plan's
    own title (agent-authored data), substituted verbatim. */
const COPY: Record<"en" | "ko", {
  turnComplete: string;
  planPending: string; // {title} placeholder
  planPendingNoTitle: string;
  stallPaused: string;
}> = {
  en: {
    turnComplete: "Turn finished",
    planPending: "Plan review: {title}",
    planPendingNoTitle: "Plan review — answer needed",
    stallPaused: "Stall auto-continue paused — send a prompt to re-arm",
  },
  // DRAFT — requires native-speaker review before release (issue #363).
  ko: {
    turnComplete: "턴이 끝났습니다",
    planPending: "플랜 검토: {title}",
    planPendingNoTitle: "플랜 검토 — 응답 필요",
    stallPaused: "자동 계속 실행 일시 중지 — 다시 시작하려면 프롬프트를 보내세요",
  },
};

export class DesktopNotifier implements Attention {
  private readonly tabs = new Map<string, TabAttention>();
  private warnedUnsupported = false;
  private warnedShowFailure = false;

  constructor(private readonly deps: DesktopNotifierDeps) {}

  // --- Attention (SessionManager hooks) ---------------------------------

  turnStarted(tabId: string): void {
    this.drop(tabId);
  }

  turnEnded(tabId: string): void {
    this.schedule(tabId, "turn-complete", null);
  }

  planProposed(tabId: string, planTitle: string): void {
    this.schedule(tabId, "plan-pending", planTitle);
  }

  planSettled(tabId: string): void {
    this.drop(tabId, "plan-pending");
  }

  viewedChanged(tabId: string): void {
    this.drop(tabId);
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
    // Main-process tests may mock electron without Notification; treat a
    // missing class like an unsupported platform instead of throwing.
    if (typeof Notification !== "function" || !Notification.isSupported()) {
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
    entry.notification = notification;
  }

  /** Notification copy: the session's sidebar title, the state as body. */
  private copyFor(tabId: string, entry: TabAttention): { title: string; body: string } {
    const title = this.deps.titleOf(tabId);
    const copy = COPY[this.deps.localeId() === "ko" ? "ko" : "en"];
    switch (entry.kind) {
      case "turn-complete":
        return { title, body: copy.turnComplete };
      case "plan-pending":
        return {
          title,
          body:
            entry.planTitle !== null && entry.planTitle.trim() !== ""
              ? copy.planPending.replace("{title}", entry.planTitle)
              : copy.planPendingNoTitle,
        };
      case "stall-paused":
        return { title, body: copy.stallPaused };
    }
  }

  /**
   * Click handler: bring the window forward (restore if minimized, show if
   * macOS-hidden) and fan the focus event to every renderer; each resurfaces
   * (or resumes) the tab through the ordinary openSession path.
   */
  private focusSession(tabId: string): void {
    const win = this.deps.win;
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.deps.send(CH.onFocusSession, tabId);
  }
}
