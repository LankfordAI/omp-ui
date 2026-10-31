import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  DeviceButton,
  DevicePaneInputEvent,
  DevicePaneState,
  DeviceTarget,
} from "@omp-ui/core/device-pane";
import { backend } from "../../backend";
import { createFramePainter } from "../../lib/browser-pane-frame";
import { cn } from "../../lib/cn";
import { isAppHotkey } from "../../lib/hotkeys";
import { useT } from "../../lib/i18n";
import { findInstance, findOwner, registerDevicePaneWriter, useStore, viewedClientId } from "../../store";
import { Button, ConfirmDialog, Dot, ICON_STROKE, IconButton, IconClose, IconRefresh } from "../ui";

/**
 * The device pane (issue #1006): the tab's bound Android emulator, painted
 * from main's JPEG frames, with touch, wheel, keys and text sent back. One
 * component, three postures like the browser pane: a desktop split beside the
 * transcript, the full transcript column, or the compact shell's bottom sheet.
 */
export type DevicePanePosture = "split" | "column" | "sheet";

/** How long the attach confirmation stays in the toolbar. */
const ATTACHED_NOTE_MS = 2_000;
/** Touch slots the emulator accepts; a pointer beyond them is dropped. */
const POINTER_SLOTS = 10;
/** The proto warns that text over 1 kB can overrun the keyboard buffer. */
const TEXT_CHUNK = 1024;
/** Keys forwarded as key events; every other character arrives as text. */
const FORWARDED_KEYS: Record<string, true> = {
  Enter: true,
  Backspace: true,
  Tab: true,
  Escape: true,
  Delete: true,
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Home: true,
  End: true,
  PageUp: true,
  PageDown: true,
};

function IconBack() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M11 3.5L4.5 8l6.5 4.5z" {...ICON_STROKE} />
    </svg>
  );
}

function IconHome() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <circle cx="8" cy="8" r="4.5" {...ICON_STROKE} />
    </svg>
  );
}

function IconRecents() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1" {...ICON_STROKE} />
    </svg>
  );
}

/** A camera: the device's screenshot goes to the composer. */
function IconAttach() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M2.5 5.5h2.2l1.1-1.7h4.4l1.1 1.7h2.2v7h-11z" {...ICON_STROKE} />
      <circle cx="8" cy="8.8" r="2.2" {...ICON_STROKE} />
    </svg>
  );
}

function IconPower() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M8 2v5.5" {...ICON_STROKE} />
      <path d="M4.8 4.4a5 5 0 1 0 6.4 0" {...ICON_STROKE} />
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

/** Unit coordinates over the painted frame: the canvas box is the frame, letterboxed. */
function unitPoint(canvas: HTMLCanvasElement, offsetX: number, offsetY: number): { x: number; y: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const x = w === 0 ? 0 : offsetX / w;
  const y = h === 0 ? 0 : offsetY / h;
  return {
    x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0,
    y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0,
  };
}

/** Wheel lines are ~40 px; pixel deltas scale by 1.2. Bounded to the codec's ±10 000. */
function wheelDelta(delta: number, deltaMode: number): number {
  const scaled = Math.round(-delta * (deltaMode === 1 ? 40 : 1.2));
  return Math.max(-10_000, Math.min(10_000, scaled));
}

/** Splits text into code-point-safe chunks no longer than the codec allows. */
function textChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (chunk.length + ch.length > TEXT_CHUNK) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

/** The select's value for a target: running emulators bind, stopped AVDs boot. */
function targetValue(target: DeviceTarget): string {
  return target.serial !== null ? `serial:${target.serial}` : `avd:${target.avd}`;
}

function currentTargetValue(state: DevicePaneState | null): string {
  if (state?.serial != null) return `serial:${state.serial}`;
  if (state?.avd != null) return `avd:${state.avd}`;
  return "";
}

export function DevicePane({ tabId, posture }: { tabId: string; posture: DevicePanePosture }) {
  const t = useT();
  const pane = useStore((s) => s.rpc[tabId]?.devicePane);
  /** Hidden tabs stay mounted (display:none); only the viewed one takes frames. */
  const active = useStore((s) => s.activeTabId === tabId);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  // While the owning remote instance is not joined, nothing sent here could
  // reach the device: the toolbar is inert and the last frame stays.
  const instanceDown = useStore(
    (s) => instanceId !== null && findInstance(s.state, instanceId)?.status !== "joined",
  );
  const ensureDevicePane = useStore((s) => s.ensureDevicePane);
  const actDevicePane = useStore((s) => s.actDevicePane);
  const closeDevicePane = useStore((s) => s.closeDevicePane);
  const setDevicePaneFullscreen = useStore((s) => s.setDevicePaneFullscreen);
  const noteDevicePaneFrame = useStore((s) => s.noteDevicePaneFrame);
  const queueComposerAttachment = useStore((s) => s.queueComposerAttachment);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The keyboard proxy: holds focus behind the canvas so keys and the IME land somewhere. */
  const proxyRef = useRef<HTMLInputElement | null>(null);
  /** Live pointers: browser pointerId → emulator touch slot and last unit point. */
  const pointers = useRef(new Map<number, { slot: number; x: number; y: number }>());
  /** The newest move per slot waiting for the next animation frame. */
  const pendingMoves = useRef(new Map<number, DevicePaneInputEvent>());
  const moveFrame = useRef(0);

  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [attachedAt, setAttachedAt] = useState(0);
  const [confirmPowerOff, setConfirmPowerOff] = useState(false);

  const ensure = pane?.ensure ?? "idle";
  const state = pane?.state ?? null;
  const inventory = pane?.inventory ?? null;
  const frame = pane?.frame ?? null;
  const phase = state?.phase ?? "unbound";
  const available = ensure === "available";
  const streaming = available && phase === "streaming";
  /** Input reaches the device only through a joined instance with a live stream. */
  const live = streaming && !instanceDown;
  /** The last frame stays painted while the stream errors; a rebind starts fresh. */
  const showFrame = frame !== null && (phase === "streaming" || phase === "error");

  // The posture survives a reboot but the ensure answer does not: every
  // mount re-asks main, and a stale answer is dropped by the store.
  useEffect(() => {
    if (ensure === "idle" && !instanceDown) void ensureDevicePane(tabId);
  }, [ensure, instanceDown, tabId, ensureDevicePane]);

  // Frames paint straight from the JPEG registry, never through React state.
  useEffect(() => {
    if (!active || instanceDown) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const painter = createFramePainter(canvas, (header) => noteDevicePaneFrame(tabId, header));
    const unregister = registerDevicePaneWriter(tabId, (bytes) => painter.write(bytes));
    return () => {
      unregister();
      painter.dispose();
    };
  }, [tabId, active, instanceDown, noteDevicePaneFrame]);

  // The sink registry: this renderer takes frames while the tab is the viewed
  // one; a down instance drops the subscription and re-subscribes on rejoin.
  // No resize channel: the stream size is fixed and every view scales.
  useEffect(() => {
    if (!active || instanceDown) return;
    const clientId = viewedClientId();
    backend.devicePaneSubscribe(tabId, clientId, true);
    return () => backend.devicePaneSubscribe(tabId, clientId, false);
  }, [tabId, active, instanceDown]);

  // The host box sizes the letterboxed canvas.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setBox((prev) =>
        prev !== null && prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (attachedAt === 0) return;
    const timer = setTimeout(() => setAttachedAt(0), ATTACHED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [attachedAt]);

  const send = useCallback(
    (event: DevicePaneInputEvent) => backend.devicePaneInput(tabId, event),
    [tabId],
  );

  // A stream that stops mid-drag forgets its fingers: main releases every
  // pointer on unbind, and input sent now could not reach the device.
  useEffect(() => {
    if (live) return;
    if (moveFrame.current !== 0) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    pendingMoves.current.clear();
    pointers.current.clear();
  }, [live]);
  // A pane that unmounts mid-drag lifts every finger it put down;
  // pointercancel never fires for a removed canvas.
  useEffect(() => {
    const held = pointers.current;
    return () => {
      if (moveFrame.current !== 0) cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      for (const { slot, x, y } of held.values()) send({ type: "touch", phase: "up", x, y, pointer: slot });
      held.clear();
    };
  }, [send]);

  const flushMoves = (): void => {
    moveFrame.current = 0;
    const moves = [...pendingMoves.current.values()];
    pendingMoves.current.clear();
    for (const move of moves) send(move);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    // The compat mousedown would move focus to <body> (a canvas is not
    // focusable); preventing it keeps the keyboard on the proxy.
    e.preventDefault();
    proxyRef.current?.focus({ preventScroll: true });
    if (!live || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (pointers.current.has(e.pointerId)) return;
    const used = new Set([...pointers.current.values()].map((p) => p.slot));
    let slot = -1;
    for (let i = 0; i < POINTER_SLOTS; i++) {
      if (!used.has(i)) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = unitPoint(e.currentTarget, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    pointers.current.set(e.pointerId, { slot, x, y });
    send({ type: "touch", phase: "down", x, y, pointer: slot });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const held = pointers.current.get(e.pointerId);
    if (held === undefined || !live) return;
    const { x, y } = unitPoint(e.currentTarget, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    held.x = x;
    held.y = y;
    pendingMoves.current.set(held.slot, { type: "touch", phase: "move", x, y, pointer: held.slot });
    if (moveFrame.current === 0) moveFrame.current = requestAnimationFrame(flushMoves);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const held = pointers.current.get(e.pointerId);
    if (held === undefined) return;
    pointers.current.delete(e.pointerId);
    pendingMoves.current.delete(held.slot);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const point =
      e.type === "pointercancel"
        ? { x: held.x, y: held.y }
        : unitPoint(e.currentTarget, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    send({ type: "touch", phase: "up", x: point.x, y: point.y, pointer: held.slot });
  };

  // React registers `wheel` passively, where preventDefault is a no-op; the
  // canvas takes its own non-passive listener so the transcript never scrolls
  // under the device. The handler lives in a ref so one registration sees
  // every render's `live`.
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  onWheel.current = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!live || canvas === null) return;
    const dx = wheelDelta(e.deltaX, e.deltaMode);
    const dy = wheelDelta(e.deltaY, e.deltaMode);
    if (dx === 0 && dy === 0) return;
    const { x, y } = unitPoint(canvas, e.offsetX, e.offsetY);
    send({ type: "wheel", x, y, dx, dy });
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const listener = (e: WheelEvent): void => onWheel.current(e);
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, []);

  const sendText = (text: string): void => {
    for (const chunk of textChunks(text)) send({ type: "text", text: chunk });
  };

  // `beforeinput` is not a React synthetic event; typed characters go as text
  // and never land in the proxy's value.
  const onBeforeInput = useRef<(e: InputEvent) => void>(() => {});
  onBeforeInput.current = (e) => {
    if (e.inputType !== "insertText" && e.inputType !== "insertFromPaste") return;
    e.preventDefault();
    if (live && e.data) sendText(e.data);
  };
  useEffect(() => {
    const proxy = proxyRef.current;
    if (proxy === null) return;
    const listener = (e: InputEvent): void => onBeforeInput.current(e);
    proxy.addEventListener("beforeinput", listener);
    return () => proxy.removeEventListener("beforeinput", listener);
  }, []);

  const onCompositionEnd = (e: CompositionEvent<HTMLInputElement>): void => {
    if (live && e.data) sendText(e.data);
    e.currentTarget.value = "";
  };

  const onKey = (phase: "down" | "up", e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    // The app's own chords (⌘K, ⌘F, …) keep their meaning over the device.
    if (isAppHotkey(e.nativeEvent)) return;
    if (FORWARDED_KEYS[e.key] !== true) return;
    e.preventDefault();
    if (live) send({ type: "key", phase, key: e.key });
  };

  const pressButton = (button: DeviceButton): void => {
    if (live) send({ type: "button", button });
  };

  const pickTarget = (value: string): void => {
    if (value.startsWith("serial:")) void actDevicePane(tabId, { action: "bind", serial: value.slice(7) });
    else if (value.startsWith("avd:")) void actDevicePane(tabId, { action: "boot", avd: value.slice(4) });
  };

  const refresh = async (): Promise<void> => {
    if (available) await actDevicePane(tabId, { action: "refresh" });
    await ensureDevicePane(tabId);
  };

  const attach = (): void => {
    const canvas = canvasRef.current;
    if (canvas === null || !showFrame) return;
    const url = canvas.toDataURL("image/jpeg");
    const comma = url.indexOf(",");
    if (comma === -1) return;
    queueComposerAttachment(
      tabId,
      { type: "image", data: url.slice(comma + 1), mimeType: "image/jpeg" },
      `Android emulator ${state?.avd ?? ""} (${state?.serial ?? ""})`,
    );
    setAttachedAt(Date.now());
  };

  const powerOff = (): void => {
    setConfirmPowerOff(false);
    void actDevicePane(tabId, { action: "power-off" });
  };

  const agent = state?.agent ?? "detached";
  const acting = agent === "acting";
  const controlsDisabled = instanceDown || !streaming;
  /** The column posture forced by a too-narrow window cannot be split back by hand. */
  const forcedColumn = posture === "column" && pane?.fullscreen !== true;

  const targets = inventory?.targets ?? [];
  const selected = currentTargetValue(state);
  const selectedListed = selected === "" || targets.some((target) => targetValue(target) === selected);
  const targetLabel = (target: DeviceTarget): string =>
    target.state === "running"
      ? t("device.target.running", { avd: target.avd })
      : target.state === "booting"
        ? t("device.target.booting", { avd: target.avd })
        : t("device.target.stopped", { avd: target.avd });

  let status: string | null = null;
  if (ensure === "pending" || ensure === "idle") status = showFrame ? null : t("device.state.pending");
  else if (ensure === "not-live") status = t("device.state.notLive");
  else if (inventory?.sdk.status === "missing") {
    status = t("device.state.sdkMissing", { missing: inventory.sdk.missing.join(", ") });
  } else if (phase === "unbound") {
    status = targets.length === 0 ? t("device.state.noTargets") : t("device.state.unbound");
  } else if (phase === "booting") status = t("device.state.booting", { avd: state?.avd ?? "" });
  else if (phase === "connecting") status = t("device.state.connecting", { avd: state?.avd ?? state?.serial ?? "" });
  else if (phase === "error" && !showFrame) status = state?.error ?? t("device.state.error");
  else if (!showFrame) status = t("device.state.noFrames");

  // Letterboxed to the frame aspect inside the host box; the canvas box is
  // exactly the frame, so pointer offsets map straight to unit coordinates.
  let canvasSize: { width: number; height: number } | undefined;
  if (frame !== null && box !== null && box.width > 0 && box.height > 0 && frame.width > 0 && frame.height > 0) {
    const scale = Math.min(box.width / frame.width, box.height / frame.height);
    canvasSize = { width: Math.floor(frame.width * scale), height: Math.floor(frame.height * scale) };
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      {/* The agent is acting: a 1 px copper frame pulses over the whole pane,
          never dimming the device under it. */}
      {acting && <div aria-hidden className="pointer-events-none absolute inset-0 z-10 animate-pulse border border-copper" />}
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-sunken px-2 py-1">
        <select
          aria-label={t("device.toolbar.target")}
          disabled={instanceDown || !available}
          value={selected}
          onChange={(e) => pickTarget(e.target.value)}
          className={cn(
            "h-6 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-[11px] text-ink outline-none",
            "focus:border-line-strong disabled:text-ink-faint",
          )}
        >
          {selected === "" && (
            <option value="" disabled>
              {targets.length === 0 ? t("device.toolbar.noTargets") : t("device.toolbar.choose")}
            </option>
          )}
          {!selectedListed && (
            <option value={selected} disabled>
              {state?.avd ?? state?.serial ?? selected}
            </option>
          )}
          {targets.map((target) => (
            <option key={targetValue(target)} value={targetValue(target)}>
              {targetLabel(target)}
            </option>
          ))}
        </select>
        <IconButton label={t("device.toolbar.refresh")} disabled={instanceDown} onClick={() => void refresh()}>
          <IconRefresh />
        </IconButton>
        <IconButton label={t("device.toolbar.back")} disabled={controlsDisabled} onClick={() => pressButton("back")}>
          <IconBack />
        </IconButton>
        <IconButton label={t("device.toolbar.home")} disabled={controlsDisabled} onClick={() => pressButton("home")}>
          <IconHome />
        </IconButton>
        <IconButton
          label={t("device.toolbar.recents")}
          disabled={controlsDisabled}
          onClick={() => pressButton("recents")}
        >
          <IconRecents />
        </IconButton>
        {agent !== "detached" && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 px-1 text-[10px]",
              acting ? "text-copper" : "text-ink-dim",
            )}
          >
            <Dot tone={acting ? "copper" : "signal"} pulse={acting} />
            {acting ? t("device.agent.acting") : t("device.agent.attached")}
          </span>
        )}
        <span className="relative shrink-0">
          <IconButton label={t("device.toolbar.attach")} disabled={controlsDisabled || !showFrame} onClick={attach}>
            <IconAttach />
          </IconButton>
          {attachedAt !== 0 && (
            <span
              role="status"
              className="pointer-events-none absolute right-0 top-full z-10 mt-0.5 whitespace-nowrap rounded-md border border-line bg-overlay px-2 py-1 text-[10px] text-ink-mid"
            >
              {t("device.toolbar.attached")}
            </span>
          )}
        </span>
        <IconButton
          label={t("device.toolbar.powerOff")}
          tone="rose"
          disabled={controlsDisabled}
          onClick={() => setConfirmPowerOff(true)}
        >
          <IconPower />
        </IconButton>
        {posture !== "sheet" && (
          <>
            <IconButton
              label={posture === "column" ? t("device.toolbar.split") : t("device.toolbar.fullscreen")}
              disabled={forcedColumn}
              onClick={() => setDevicePaneFullscreen(tabId, posture !== "column")}
            >
              {posture === "column" ? <IconSplit /> : <IconFullscreen />}
            </IconButton>
            <IconButton label={t("device.toolbar.close")} onClick={() => closeDevicePane(tabId)}>
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
        aria-label={t("device.surface.label")}
        onFocus={(e) => {
          if (e.target === e.currentTarget) proxyRef.current?.focus({ preventScroll: true });
        }}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-void outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-line-strong"
      >
        {/* Physical frame px in the attributes; the CSS box is the letterboxed fit. */}
        <canvas
          ref={canvasRef}
          style={{
            ...canvasSize,
            opacity: instanceDown ? 0.5 : 1,
            visibility: showFrame ? "visible" : "hidden",
          }}
          className={cn("block touch-none", live ? "cursor-default" : "cursor-not-allowed")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
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
          onKeyDown={(e) => onKey("down", e)}
          onKeyUp={(e) => onKey("up", e)}
          onCompositionEnd={onCompositionEnd}
        />
        {status !== null && (
          <p className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-[11px] leading-snug text-ink-dim">
            {status}
          </p>
        )}
        {instanceDown ? (
          <p className="pointer-events-none absolute inset-x-0 top-0 bg-overlay/85 px-3 py-1 text-center text-[10px] text-ink-mid backdrop-glass">
            {t("device.state.instanceDown")}
          </p>
        ) : (
          phase === "error" &&
          showFrame && (
            <p className="pointer-events-none absolute inset-x-0 top-0 bg-overlay/85 px-3 py-1 text-center text-[10px] text-rose backdrop-glass">
              {state?.error ?? t("device.state.error")}
            </p>
          )
        )}
      </div>

      {confirmPowerOff && (
        <ConfirmDialog
          kicker={t("device.powerOff.kicker")}
          title={t("device.powerOff.title", { avd: state?.avd ?? state?.serial ?? "" })}
          tone="rose"
          onClose={() => setConfirmPowerOff(false)}
          actions={
            <>
              <Button size="sm" onClick={() => setConfirmPowerOff(false)}>
                {t("common.dialog.cancel")}
              </Button>
              <Button size="sm" tone="rose" onClick={powerOff}>
                {t("device.powerOff.confirm")}
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-ink-mid">{t("device.powerOff.body")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
