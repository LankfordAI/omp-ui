import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  browserClockText,
  isAllowedBrowserPaneTopLevelUrl,
  type BrowserPaneInputEvent,
  type BrowserPanePickResult,
} from "@omp-ui/core/browser-pane";
import { backend, desktopPaneMedia } from "../../backend";
import { createFramePainter, cropFrame, type PanePainter } from "../../lib/browser-pane-frame";
import { createMediaPainter } from "../../lib/browser-pane-media";
import {
  compositionCancel,
  compositionEnd,
  compositionUpdate,
  keyEvents,
  pointerEvents,
  mapPointer,
  wheelEvents,
  type KeyLike,
  type PointerContext,
  type PointerKind,
  type PointerLike,
} from "../../lib/browser-pane-input";
import { bytesToBase64 } from "../../lib/clipboard-image";
import { cn } from "../../lib/cn";
import { isAppHotkey } from "../../lib/hotkeys";
import { STAMPED_JPEG_QUALITY, stampImage } from "../../lib/clock-stamp";
import { currentLocaleId, useT } from "../../lib/i18n";
import { IS_ELECTRON, IS_MAC } from "../../lib/platform";
import { findInstance, findOwner, registerBrowserPaneWriter, useStore, viewedClientId } from "../../store";
import { Dot, ICON_STROKE, IconButton, IconClose } from "../ui";
import { BrowserPaneClock } from "./BrowserPaneClock";

/**
 * The browser pane (issue #519, ADR-0029): the session's shared page, painted
 * from local tab capture or remote JPEG frames, with input translated back
 * to the page. One component, three postures: a desktop split beside the
 * transcript, the full transcript column, or the compact shell's bottom sheet.
 */
export type BrowserPanePosture = "split" | "column" | "sheet";

/** How long the attach confirmation stays in the toolbar. */
const ATTACHED_NOTE_MS = 2_000;

function IconBack() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M10 3.5L5.5 8 10 12.5" {...ICON_STROKE} />
    </svg>
  );
}

function IconForward() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M6 3.5L10.5 8 6 12.5" {...ICON_STROKE} />
    </svg>
  );
}

function IconReload() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M12.6 6.6A4.9 4.9 0 1 0 12.9 9.2" {...ICON_STROKE} />
      <path d="M12.8 3.2v3.4H9.4" {...ICON_STROKE} />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <rect x="4" y="4" width="8" height="8" rx="1.2" {...ICON_STROKE} />
    </svg>
  );
}

/** A camera: the page's screenshot and URL go to the composer. */
function IconAttach() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M2.5 5.5h2.2l1.1-1.7h4.4l1.1 1.7h2.2v7h-11z" {...ICON_STROKE} />
      <circle cx="8" cy="8.8" r="2.2" {...ICON_STROKE} />
    </svg>
  );
}

/** Crosshair for selecting one page element. */
function IconPick() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <circle cx="8" cy="8" r="3" {...ICON_STROKE} />
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" {...ICON_STROKE} />
    </svg>
  );
}

function IconFullscreen() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" {...ICON_STROKE} />
    </svg>
  );
}

function IconSplit() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" {...ICON_STROKE} />
      <path d="M9 2.5v11" {...ICON_STROKE} />
    </svg>
  );
}

/** Adds `https://` to a bare host; returns null for anything the pane refuses to load. */
function completeAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const completed = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return isAllowedBrowserPaneTopLevelUrl(completed) ? completed : null;
}

function pointerLike(e: ReactPointerEvent<HTMLCanvasElement>): PointerLike {
  return {
    offsetX: e.nativeEvent.offsetX,
    offsetY: e.nativeEvent.offsetY,
    button: e.button,
    buttons: e.buttons,
    detail: e.detail,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    capsLock: e.getModifierState("CapsLock"),
  };
}

function keyLike(e: ReactKeyboardEvent<HTMLInputElement>): KeyLike {
  return {
    key: e.key,
    location: e.location,
    isComposing: e.nativeEvent.isComposing,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    capsLock: e.getModifierState("CapsLock"),
    altGraph: e.getModifierState("AltGraph"),
  };
}

export function BrowserPane({ tabId, posture }: { tabId: string; posture: BrowserPanePosture }) {
  const t = useT();
  const pane = useStore((s) => s.rpc[tabId]?.browserPane);
  /** Hidden tabs stay mounted (display:none); only the viewed one takes frames. */
  const active = useStore((s) => s.activeTabId === tabId);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  // While the owning remote instance is not joined, nothing sent here could
  // reach the page: the toolbar is inert and the last frame stays (issue #416).
  const instanceDown = useStore(
    (s) => instanceId !== null && findInstance(s.state, instanceId)?.status !== "joined",
  );
  /** The browser clock follows the tab's project on whichever host owns it. */
  const clockOn = useStore((s) => {
    const owner = findOwner(s.state, tabId);
    if (owner === undefined) return false;
    const groups = owner.instanceId === null ? s.state?.projects : findInstance(s.state, owner.instanceId)?.projects;
    return groups?.find((g) => g.project.path === owner.record.projectCwd)?.project.browserClock === true;
  });
  const ensureBrowserPane = useStore((s) => s.ensureBrowserPane);
  const closeBrowserPane = useStore((s) => s.closeBrowserPane);
  const setBrowserPaneFullscreen = useStore((s) => s.setBrowserPaneFullscreen);
  const noteBrowserPaneFrame = useStore((s) => s.noteBrowserPaneFrame);
  const queueComposerAttachment = useStore((s) => s.queueComposerAttachment);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The IME proxy: holds focus behind the canvas so the OS composes into something. */
  const proxyRef = useRef<HTMLInputElement | null>(null);
  const composition = useRef<{ active: boolean; committed: string | null; preedit: boolean }>({
    active: false,
    committed: null,
    preedit: false,
  });
  const painterRef = useRef<PanePainter | null>(null);
  /** The newest pointer move waiting for the next animation frame (latest wins). */
  const pendingMove = useRef<BrowserPaneInputEvent[] | null>(null);
  const moveFrame = useRef(0);

  /** The address bar's draft while the user edits it; null follows the page. */
  const [draft, setDraft] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [attachedAt, setAttachedAt] = useState(0);
  const [stampFailedAt, setStampFailedAt] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pickNote, setPickNote] = useState<"miss" | null>(null);

  const ensure = pane?.ensure ?? "idle";
  const state = pane?.state ?? null;
  const hasFrame = pane?.frame != null;
  const available = ensure === "available";
  /** Input reaches the page only through a joined instance with a page to receive it. */
  const live = available && !instanceDown;

  // The posture survives a reboot but the ensure answer does not (#528):
  // every mount re-asks main, and a stale answer is dropped by the store.
  useEffect(() => {
    if (ensure === "idle" && !instanceDown) void ensureBrowserPane(tabId);
  }, [ensure, instanceDown, tabId, ensureBrowserPane]);

  // Frames paint directly from tab capture or the JPEG registry, never through React state.
  useEffect(() => {
    if (!active || instanceDown) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onHeader = (header: Parameters<typeof noteBrowserPaneFrame>[1]): void => noteBrowserPaneFrame(tabId, header);
    let painter: PanePainter;
    let unregister: (() => void) | undefined;
    if (instanceId === null && desktopPaneMedia !== null) {
      painter = createMediaPainter(canvas, desktopPaneMedia, tabId, onHeader);
    } else {
      const frames = createFramePainter(canvas, onHeader);
      painter = frames;
      unregister = registerBrowserPaneWriter(tabId, (frame) => frames.write(frame));
    }
    painterRef.current = painter;
    return () => {
      unregister?.();
      painter.dispose();
      painterRef.current = null;
    };
  }, [tabId, active, instanceId, instanceDown, noteBrowserPaneFrame]);

  // The sink registry (#529): this renderer takes frames while the tab is the
  // viewed one; a down instance drops the subscription and re-subscribes the
  // moment it rejoins.
  useEffect(() => {
    if (!active || instanceDown) return;
    const clientId = viewedClientId();
    backend.browserPaneSubscribe(tabId, clientId, true);
    return () => backend.browserPaneSubscribe(tabId, clientId, false);
  }, [tabId, active, instanceDown]);

  // Only the local desktop renderer's box sizes the page (#532); other views
  // scale the frame they are given. The sheet is a peek, not a viewport.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !IS_ELECTRON || posture === "sheet" || instanceDown) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width === 0 || rect.height === 0) return;
      backend.browserPaneResize(tabId, Math.round(rect.width), Math.round(rect.height));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [tabId, posture, instanceDown]);

  useEffect(() => {
    if (attachedAt === 0) return;
    const timer = setTimeout(() => setAttachedAt(0), ATTACHED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [attachedAt]);

  useEffect(() => {
    if (stampFailedAt === 0) return;
    const timer = setTimeout(() => setStampFailedAt(0), ATTACHED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [stampFailedAt]);

  useEffect(() => {
    if (pickNote === null) return;
    const timer = setTimeout(() => setPickNote(null), ATTACHED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [pickNote]);

  useEffect(() => {
    setPicking(false);
    setPickNote(null);
  }, [tabId, instanceDown, live]);

  useEffect(
    () => () => {
      if (moveFrame.current !== 0) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  const send = useCallback(
    (events: BrowserPaneInputEvent[]) => {
      for (const event of events) backend.browserPaneInput(tabId, event);
    },
    [tabId],
  );

  /** Canvas box and the frame it shows; null before the first frame (no mapping yet). */
  const pointerContext = (canvas: HTMLCanvasElement): PointerContext | null => {
    const header = painterRef.current?.header() ?? null;
    if (header === null) return null;
    return { box: { width: canvas.clientWidth, height: canvas.clientHeight }, header };
  };
  const onPointer = (kind: PointerKind, e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (kind === "down") {
      // The compat mousedown that follows would move focus to <body> (a canvas
      // is not focusable); preventing it keeps the keyboard on the proxy.
      e.preventDefault();
      proxyRef.current?.focus({ preventScroll: true });
      if (picking) {
        const ctx = pointerContext(e.currentTarget);
        if (ctx !== null && live) {
          const point = mapPointer(e.nativeEvent.offsetX, e.nativeEvent.offsetY, ctx.box, ctx.header);
          void pick(point);
        }
        return;
      }
    }
    if (picking || !live) return;
    const ctx = pointerContext(e.currentTarget);
    if (ctx === null) return;
    const events = pointerEvents(kind, pointerLike(e), ctx);
    if (kind !== "move") {
      send(events);
      return;
    }
    pendingMove.current = events;
    if (moveFrame.current !== 0) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const latest = pendingMove.current;
      pendingMove.current = null;
      if (latest !== null) send(latest);
    });
  };

  // React registers `wheel` passively, where preventDefault is a no-op; the
  // canvas takes its own non-passive listener so the transcript behind the
  // pane never scrolls on a page scroll. The handler lives in a ref so one
  // registration sees every render's `live`.
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  onWheel.current = (e) => {
    e.preventDefault();
    if (!live) return;
    const canvas = canvasRef.current;
    const ctx = canvas === null ? null : pointerContext(canvas);
    if (ctx === null) return;
    send(
      wheelEvents(
        {
          offsetX: e.offsetX,
          offsetY: e.offsetY,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          capsLock: e.getModifierState("CapsLock"),
        },
        ctx,
      ),
    );
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const listener = (e: WheelEvent): void => onWheel.current(e);
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, []);

  const onKey = (kind: "keydown" | "keyup", e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (picking && kind === "keydown" && e.key === "Escape") {
      e.preventDefault();
      setPicking(false);
      return;
    }
    if (kind === "keydown" && !e.nativeEvent.isComposing) composition.current.committed = null;
    // The app's own chords (⌘K, ⌘F, …) keep their meaning over the page.
    if (isAppHotkey(e.nativeEvent)) return;
    const { events, preventDefault } = keyEvents(kind, keyLike(e), { darwin: IS_MAC });
    // Prevented on the proxy so a typed character never lands in its value;
    // composing keys pass so the IME can write there until compositionend.
    if (preventDefault) e.preventDefault();
    if (live) send(events);
  };

  const onCompositionUpdate = (e: CompositionEvent<HTMLInputElement>): void => {
    const data = e.data ?? "";
    composition.current.preedit = data !== "";
    if (live) send(compositionUpdate(data));
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLInputElement>): void => {
    composition.current.active = false;
    composition.current.committed = e.data || null;
    if (live) {
      // A nonempty commit replaces the live composition. An empty one must clear the page's preedit.
      if (e.data !== "") send(compositionEnd(e.data));
      else if (composition.current.preedit) send(compositionCancel());
    }
    composition.current.preedit = false;
    e.currentTarget.value = "";
  };

  const onProxyInput = (e: FormEvent<HTMLInputElement>): void => {
    const input = e.nativeEvent as InputEvent;
    if (composition.current.active || input.isComposing) return;
    // IBus commits after an empty compositionend; other IMEs include the
    // text in compositionend and may repeat it in the following input (#550).
    if (live && input.data && input.data !== composition.current.committed) {
      send(compositionEnd(input.data));
    }
    composition.current.committed = null;
    e.currentTarget.value = "";
  };

  const navigate = (action: "back" | "forward" | "reload" | "stop"): void => {
    if (!live) return;
    backend.browserPaneNavigate(tabId, { action });
  };

  const submitAddress = (): void => {
    if (!live) return;
    const completed = completeAddress(draft ?? state?.url ?? "");
    if (completed === null) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setDraft(null);
    backend.browserPaneNavigate(tabId, { action: "goto", url: completed });
    proxyRef.current?.focus({ preventScroll: true });
  };

  /** The hand-back bytes: stamped when the clock is on; null (nothing to queue) when stamping failed. */
  const handBack = async (jpeg: Uint8Array, dsf: number): Promise<Uint8Array | null> => {
    if (!clockOn) return jpeg;
    try {
      const text = browserClockText(new Date(), currentLocaleId());
      return await stampImage(jpeg, "image/jpeg", STAMPED_JPEG_QUALITY, text, { scale: dsf });
    } catch {
      setStampFailedAt(Date.now());
      return null;
    }
  };

  const attach = async (): Promise<void> => {
    const painter = painterRef.current;
    const header = painter?.header() ?? null;
    const jpeg = await painter?.jpeg() ?? null;
    if (jpeg === null || header === null) return;
    const bytes = await handBack(jpeg, header.dsf);
    if (bytes === null) return;
    queueComposerAttachment(
      tabId,
      { type: "image", data: bytesToBase64(bytes), mimeType: "image/jpeg" },
      state?.url ?? "",
    );
    setAttachedAt(Date.now());
  };

  const pick = async (point: { x: number; y: number }): Promise<void> => {
    const canvas = canvasRef.current;
    const header = painterRef.current?.header() ?? null;
    if (canvas === null || header === null) return;
    let result: BrowserPanePickResult;
    try {
      result = await backend.browserPanePick(tabId, point.x, point.y);
    } catch {
      setPicking(false);
      return;
    }
    if (result.status === "no-page") {
      setPicking(false);
      return;
    }
    if (result.status === "miss") {
      setPickNote("miss");
      return;
    }
    const jpeg = await cropFrame(canvas, header, result.rect);
    setPicking(false);
    if (jpeg === null) return;
    const bytes = await handBack(jpeg, header.dsf);
    if (bytes === null) return;
    const where = result.framed
      ? t("browser.pick.framed", { selector: result.selector })
      : `selector: ${result.selector}`;
    const label = result.text === "" ? `<${result.tag}>` : `<${result.tag}> "${result.text}"`;
    queueComposerAttachment(
      tabId,
      { type: "image", data: bytesToBase64(bytes), mimeType: "image/jpeg" },
      `${state?.url ?? ""}\n${where} — ${label}`,
    );
    setAttachedAt(Date.now());
  };

  const agent = state?.agent ?? "detached";
  const acting = agent === "acting";
  const loading = state?.loading === true;
  const controlsDisabled = instanceDown || !available;
  /** The column posture forced by a too-narrow window cannot be split back by hand. */
  const forcedColumn = posture === "column" && pane?.fullscreen !== true;

  let status: string | null = null;
  if (ensure === "pending") status = t("browser.state.pending");
  else if (ensure === "not-live") status = t("browser.state.notLive");
  else if (ensure === "unavailable") {
    status = t("browser.state.unavailable", { reason: pane?.unavailableReason ?? "" });
  } else if (state?.error) {
    status = state.error;
  } else if (available && !hasFrame) {
    status = state?.url === null ? t("browser.state.idle") : t("browser.state.noFrames");
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      {clockOn && <BrowserPaneClock />}
      {/* The agent is acting: a 1 px copper frame pulses over the whole pane
          (SessionRow's working face), never dimming the page under it. */}
      {acting && <div aria-hidden className="pointer-events-none absolute inset-0 z-10 animate-pulse border border-copper" />}
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-sunken px-2 py-1">
        <IconButton
          label={t("browser.toolbar.back")}
          disabled={controlsDisabled || state?.canGoBack !== true}
          onClick={() => navigate("back")}
        >
          <IconBack />
        </IconButton>
        <IconButton
          label={t("browser.toolbar.forward")}
          disabled={controlsDisabled || state?.canGoForward !== true}
          onClick={() => navigate("forward")}
        >
          <IconForward />
        </IconButton>
        {loading ? (
          <IconButton label={t("browser.toolbar.stop")} disabled={controlsDisabled} onClick={() => navigate("stop")}>
            <IconStop />
          </IconButton>
        ) : (
          <IconButton
            label={t("browser.toolbar.reload")}
            disabled={controlsDisabled}
            onClick={() => navigate("reload")}
          >
            <IconReload />
          </IconButton>
        )}
        <div className="relative min-w-0 flex-1">
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            aria-label={t("browser.toolbar.address")}
            aria-invalid={blocked || undefined}
            placeholder={t("browser.toolbar.addressPlaceholder")}
            disabled={controlsDisabled}
            value={draft ?? state?.url ?? ""}
            onChange={(e) => {
              setDraft(e.target.value);
              setBlocked(false);
            }}
            onBlur={() => {
              if (!blocked) setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitAddress();
              } else if (e.key === "Escape") {
                setDraft(null);
                setBlocked(false);
                e.currentTarget.blur();
              }
            }}
            className={cn(
              "h-6 w-full rounded-md border bg-surface px-2 font-mono text-[11px] text-ink outline-none",
              "placeholder:text-ink-faint focus:border-line-strong disabled:text-ink-faint",
              blocked ? "border-rose" : "border-line",
            )}
          />
          {blocked && (
            <p role="alert" className="absolute inset-x-0 top-full z-10 mt-0.5 rounded-md border border-rose bg-overlay px-2 py-1 text-[10px] leading-snug text-rose">
              {t("browser.toolbar.blocked")}
            </p>
          )}
        </div>
        {agent !== "detached" && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 px-1 text-[10px]",
              acting ? "text-copper" : "text-ink-dim",
            )}
          >
            <Dot tone={acting ? "copper" : "signal"} pulse={acting} />
            {acting ? t("browser.agent.acting") : t("browser.agent.attached")}
          </span>
        )}
        <span className="relative shrink-0">
          <IconButton
            label={t("browser.toolbar.attach")}
            disabled={!hasFrame}
            onClick={() => void attach()}
          >
            <IconAttach />
          </IconButton>
          {stampFailedAt !== 0 ? (
            <span
              role="alert"
              className="pointer-events-none absolute right-0 top-full z-10 mt-0.5 whitespace-nowrap rounded-md border border-rose bg-overlay px-2 py-1 text-[10px] text-rose"
            >
              {t("browser.clock.stampFailed")}
            </span>
          ) : (
            attachedAt !== 0 && (
              <span
                role="status"
                className="pointer-events-none absolute right-0 top-full z-10 mt-0.5 whitespace-nowrap rounded-md border border-line bg-overlay px-2 py-1 text-[10px] text-ink-mid"
              >
                {t("browser.toolbar.attached")}
              </span>
            )
          )}
        </span>
        <IconButton
          label={t("browser.toolbar.pick")}
          pressed={picking}
          disabled={!hasFrame || !live}
          onClick={() => setPicking((active) => !active)}
        >
          <IconPick />
        </IconButton>
        {posture !== "sheet" && (
          <>
            <IconButton
              label={posture === "column" ? t("browser.toolbar.split") : t("browser.toolbar.fullscreen")}
              disabled={forcedColumn}
              onClick={() => setBrowserPaneFullscreen(tabId, posture !== "column")}
            >
              {posture === "column" ? <IconSplit /> : <IconFullscreen />}
            </IconButton>
            <IconButton label={t("browser.toolbar.close")} onClick={() => closeBrowserPane(tabId)}>
              <IconClose className="size-3" />
            </IconButton>
          </>
        )}
      </div>

      {/* The keyboard's way in: the surface is in the tab order and hands
          focus straight to the proxy, which stays out of the accessibility tree. */}
      <div
        ref={hostRef}
        tabIndex={0}
        role="group"
        aria-label={t("browser.surface.label")}
        onFocus={(e) => {
          if (e.target === e.currentTarget) proxyRef.current?.focus({ preventScroll: true });
        }}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-void outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-line-strong"
      >
        {/* The frame, at its own aspect ratio inside the box. Physical px in
            the attributes, so a dsf-2 frame paints crisp on a dsf-2 screen. */}
        <canvas
          ref={canvasRef}
          style={{ opacity: instanceDown ? 0.5 : 1 }}
          className={cn(
            "block h-auto w-auto max-h-full max-w-full",
            picking ? "cursor-crosshair" : live ? "cursor-default" : "cursor-not-allowed",
          )}
          onPointerDown={(e) => onPointer("down", e)}
          onPointerUp={(e) => onPointer("up", e)}
          onPointerMove={(e) => onPointer("move", e)}
          onPointerLeave={(e) => onPointer("leave", e)}
          onContextMenu={(e) => e.preventDefault()}
        />
        {/* Focus lives here, behind the canvas: keys are read and forwarded,
            and the OS IME has a real text field to compose into. */}
        <input
          ref={proxyRef}
          type="text"
          aria-hidden
          tabIndex={-1}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
          onKeyDown={(e) => onKey("keydown", e)}
          onKeyUp={(e) => onKey("keyup", e)}
          onCompositionStart={() => {
            composition.current.active = true;
            composition.current.committed = null;
            composition.current.preedit = false;
          }}
          onCompositionUpdate={onCompositionUpdate}
          onCompositionEnd={onCompositionEnd}
          onInput={onProxyInput}
        />
        {status !== null && (
          <p className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-[11px] leading-snug text-ink-dim">
            {status}
          </p>
        )}
        {instanceDown && (
          <p className="pointer-events-none absolute inset-x-0 top-0 bg-overlay/85 px-3 py-1 text-center text-[10px] text-ink-mid backdrop-glass">
            {t("browser.state.instanceDown")}
          </p>
        )}
        {(picking || pickNote === "miss") && !instanceDown && (
          <p className="pointer-events-none absolute inset-x-0 top-0 bg-overlay/85 px-3 py-1 text-center text-[10px] text-ink-mid backdrop-glass">
            {pickNote === "miss" ? t("browser.pick.miss") : t("browser.pick.hint")}
          </p>
        )}
      </div>
    </div>
  );
}
