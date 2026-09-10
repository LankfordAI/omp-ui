import { Notification, type BrowserWindow } from "electron";
import type { Attention, AttentionKind } from "@omp-ui/core";

/**
 * Posts OS notifications for owned native sessions that reach an attention
 * state while the user is not looking at them (issue #271): a turn finished,
 * a plan review is pending, or stall auto-continue paused at its cap.
 *
 * The attention level itself is the host's (issue #442): this class only
 * subscribes to `attention:changed` and decides whether this desktop client
 * should banner it. The state is per tab — one notification, replaced rather
 * than stacked. Every post is delayed (NOTIFICATION_POST_DELAY_MS) and
 * re-gated at fire time so the gate reads live state at the moment the user
 * would see the banner.
 */

export interface DesktopNotifierDeps {
  win: BrowserWindow;
  /** The Settings → General switch (re-read at every fire). */
  isEnabled: () => boolean;
  /** The registry's localeId (re-read at every fire). */
  localeId: () => string;
  /** The sidebar's session title for the tab. */
  titleOf: (tabId: string) => string;
  /** OS notification icon path, or null when absent. */
  icon: () => string | null;
  /** A banner click: surface the tab in this window and nowhere else (#453). */
  surfaceTab: (tabId: string) => void;
  /** Clock, for the subscription-time cutoff. */
  now?: () => number;
}

interface TabAttention {
  kind: AttentionKind;
  planTitle: string | null;
  /** The host's stamp on the level being announced; the same stamp never re-banners. */
  atMs: number;
  notification: Notification | null;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Post delay. Must stay above STALL_CONTINUE_SETTLE_MS (1500 ms): the host's
 * stall auto-continue dispatches its prompt ~1.5 s after a stall end, in
 * another process from the one that will banner, so the next turn's
 * `attention:changed(null)` must have time to arrive and cancel the pending
 * post before it can fire.
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

export class DesktopNotifier {
  private readonly tabs = new Map<string, TabAttention>();
  /** The host stamp last seen per tab, announced or not; repeats are dropped. */
  private readonly seenAtMs = new Map<string, number>();
  /** The tab this window's own renderer reports in view (#453). */
  private clientViewedTab: string | null = null;
  /** Levels stamped at or before this were in place when we subscribed: recorded, never announced. */
  private readonly subscribedAtMs: number;
  private warnedUnsupported = false;
  private warnedShowFailure = false;

  constructor(private readonly deps: DesktopNotifierDeps) {
    this.subscribedAtMs = (deps.now ?? Date.now)();
  }

  /** The host's `attention:changed` for a tab; null clears any pending or shown banner. */
  onAttention(tabId: string, level: Attention | null): void {
    if (level === null) {
      this.seenAtMs.delete(tabId);
      this.drop(tabId);
      return;
    }
    if (this.seenAtMs.get(tabId) === level.atMs) return;
    const first = !this.seenAtMs.has(tabId);
    this.seenAtMs.set(tabId, level.atMs);
    // Observed at subscription, not raised since: the user already had their
    // chance to see it, and a restart must never re-banner every idle tab.
    if (first && level.atMs <= this.subscribedAtMs) return;
    this.schedule(tabId, level);
  }

  /** This window's renderer reports the tab it shows (#453); the fire-time gate reads it. */
  clientViewed(tabId: string | null): void {
    this.clientViewedTab = tabId;
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
  private schedule(tabId: string, level: Attention): void {
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
    this.tabs.set(tabId, {
      kind: level.kind,
      planTitle: level.planTitle,
      atMs: level.atMs,
      notification: null,
      timer,
    });
  }

  /** Closes the tab's pending or shown attention. */
  private drop(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) return;
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
    // Suppressed only while this window is focused AND its renderer shows
    // this tab. A turn that finishes while the user works a different tab is
    // exactly the case this feature exists for (issue #271); other clients'
    // viewed tabs never count — they are a different screen.
    if (
      !this.enabled() ||
      win.isDestroyed() ||
      (win.isFocused() && this.clientViewedTab === tabId)
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
   * macOS-hidden) and surface the tab in this window's renderer, which
   * resurfaces (or resumes) it through the ordinary openSession path.
   */
  private focusSession(tabId: string): void {
    const win = this.deps.win;
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.deps.surfaceTab(tabId);
  }
}
