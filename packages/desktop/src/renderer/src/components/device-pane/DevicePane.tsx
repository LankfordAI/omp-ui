import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  decodeDevicePaneFrame,
  type DeviceButton,
  type DevicePaneFrameHeader,
  type DevicePaneInputEvent,
  type EmulatorPosture,
  type EmulatorRotation,
} from "@omp-ui/core/device-pane";
import { backend } from "../../backend";
import { createFramePainter } from "../../lib/browser-pane-frame";
import { cn } from "../../lib/cn";
import { isAppHotkey } from "../../lib/hotkeys";
import { useT } from "../../lib/i18n";
import { useDismissal } from "../../lib/use-dismissal";
import { findInstance, findOwner, registerDevicePaneWriter, useStore, viewedClientId } from "../../store";
import { MenuRow } from "../MenuRow";
import { Button, ConfirmDialog, ICON_STROKE, IconButton, IconClose, IconRefresh, Label } from "../ui";
import { DevicePicker } from "./DevicePicker";

/** Placement in the shell, distinct from the emulator's physical posture. */
export type DevicePanePlacement = "split" | "column" | "sheet";
type InputIdentity = Pick<DevicePaneFrameHeader, "bindingId" | "geometryRevision">;
type InputPayload = DevicePaneInputEvent extends infer Event
  ? Event extends DevicePaneInputEvent ? Omit<Event, keyof InputIdentity> : never : never;

const ATTACHED_NOTE_MS = 2_000;
const POINTER_SLOTS = 10;
const TEXT_CHUNK = 1024;
const FORWARDED_KEYS: Record<string, true> = {
  Enter: true, Backspace: true, Tab: true, Escape: true, Delete: true,
  ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true,
  Home: true, End: true, PageUp: true, PageDown: true,
};
const POSTURES: readonly EmulatorPosture[] = ["closed", "half-open", "open", "flipped", "tent"];
const CONTROL_CLASS = "size-11 motion-reduce:transition-none";

function IconBack() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><path d="M11 3.5L4.5 8l6.5 4.5z" {...ICON_STROKE} /></svg>;
}
function IconHome() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><circle cx="8" cy="8" r="4.5" {...ICON_STROKE} /></svg>;
}
function IconRecents() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1" {...ICON_STROKE} /></svg>;
}
function IconAttach() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><path d="M2.5 5.5h2.2l1.1-1.7h4.4l1.1 1.7h2.2v7h-11z" {...ICON_STROKE} /><circle cx="8" cy="8.8" r="2.2" {...ICON_STROKE} /></svg>;
}
function IconPower() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><path d="M8 2v5.5M4.8 4.4a5 5 0 1 0 6.4 0" {...ICON_STROKE} /></svg>;
}
function IconFullscreen() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" {...ICON_STROKE} /></svg>;
}
function IconSplit() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-3.5"><rect x="2" y="2.5" width="12" height="11" rx="1.5" {...ICON_STROKE} /><path d="M9 2.5v11" {...ICON_STROKE} /></svg>;
}
function IconRotate({ right = false }: { right?: boolean }) {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-4"><path d={right ? "M11.5 5H14V2.5M13.5 5a5.5 5.5 0 1 0 .25 5" : "M4.5 5H2V2.5M2.5 5a5.5 5.5 0 1 1-.25 5"} {...ICON_STROKE} /></svg>;
}
function IconFold() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-4"><path d="M2.5 3.5 8 2l5.5 1.5v9L8 14l-5.5-1.5zM8 2v12" {...ICON_STROKE} /></svg>;
}
function IconMore() {
  return <svg viewBox="0 0 16 16" aria-hidden className="size-4"><circle cx="3" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="13" cy="8" r="1" fill="currentColor" /></svg>;
}

/** The canvas is exactly the letterboxed frame; no renderer rotation or crop. */
function unitPoint(canvas: HTMLCanvasElement, offsetX: number, offsetY: number): { x: number; y: number } {
  const x = canvas.clientWidth === 0 ? 0 : offsetX / canvas.clientWidth;
  const y = canvas.clientHeight === 0 ? 0 : offsetY / canvas.clientHeight;
  return { x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0, y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0 };
}
function wheelDelta(delta: number, deltaMode: number): number {
  return Math.max(-10_000, Math.min(10_000, Math.round(-delta * (deltaMode === 1 ? 40 : 1.2))));
}
function textChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (chunk.length + ch.length > TEXT_CHUNK) { chunks.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

export function DevicePane({ tabId, placement }: { tabId: string; placement: DevicePanePlacement }) {
  const t = useT();
  const pane = useStore((s) => s.rpc[tabId]?.devicePane);
  const active = useStore((s) => s.activeTabId === tabId);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const instanceDown = useStore((s) => instanceId !== null && findInstance(s.state, instanceId)?.status !== "joined");
  const ownerName = useStore((s) => instanceId === null ? null : findInstance(s.state, instanceId)?.nickname ?? instanceId) ?? t("quickopen.host.local");
  const ensureDevicePane = useStore((s) => s.ensureDevicePane);
  const actDevicePane = useStore((s) => s.actDevicePane);
  const closeDevicePane = useStore((s) => s.closeDevicePane);
  const setDevicePaneFullscreen = useStore((s) => s.setDevicePaneFullscreen);
  const noteDevicePaneFrame = useStore((s) => s.noteDevicePaneFrame);
  const queueComposerAttachment = useStore((s) => s.queueComposerAttachment);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const proxyRef = useRef<HTMLInputElement>(null);
  const pointers = useRef(new Map<number, InputIdentity & { slot: number; x: number; y: number }>());
  const keys = useRef(new Map<string, InputIdentity>());
  const composition = useRef<InputIdentity | null>(null);
  const pendingMoves = useRef(new Map<number, DevicePaneInputEvent>());
  const moveFrame = useRef(0);
  const paintedRef = useRef<DevicePaneFrameHeader | null>(null);
  const paintedGeneration = useRef(-1);
  const [painted, setPainted] = useState<DevicePaneFrameHeader | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [attachedAt, setAttachedAt] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmPowerOff, setConfirmPowerOff] = useState<{ bindingId: string; avd: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    if (menuRef.current?.contains(document.activeElement)) menuTrigger.current?.focus();
    setMenuOpen(false);
  }, []);
  useDismissal({ open: menuOpen, refs: menuRoot, onClose: closeMenu, onEscape: closeMenu, restoreFocus: () => menuTrigger.current?.focus() });

  const ensure = pane?.ensure ?? "idle";
  const state = pane?.state ?? null;
  const inventory = pane?.inventory ?? null;
  const frame = pane?.frame ?? null;
  const streamGeneration = pane?.streamGeneration ?? 0;
  const phase = state?.phase ?? "unbound";
  const available = ensure === "available";
  const paintReady = available && phase === "streaming" && state?.bindingId != null && state.screen === "active";
  const ready = paintReady && state.inputReady;
  const showFrame = paintReady && !instanceDown && painted !== null && frame !== null && paintedGeneration.current === streamGeneration
    && painted.bindingId === state.bindingId && painted.geometryRevision === state.geometryRevision
    && frame.bindingId === painted.bindingId && frame.geometryRevision === painted.geometryRevision;
  const live = active && ready && showFrame;
  const acting = state?.agent === "acting";
  const busy = state?.operation != null || acting;
  const bound = available && !instanceDown && state?.bindingId != null;
  const controlsDisabled = !bound || phase !== "streaming" || busy;
  const forcedColumn = placement === "column" && pane?.fullscreen !== true;

  /** Consult current store state, not a render closure, at each async paint/input boundary. */
  const isCurrent = useCallback((identity: InputIdentity): boolean => {
    const store = useStore.getState();
    const current = store.rpc[tabId]?.devicePane;
    const owner = findOwner(store.state, tabId)?.instanceId ?? null;
    return store.activeTabId === tabId && current?.ensure === "available" && current.streamGeneration === streamGeneration
      && owner === instanceId && (owner === null || findInstance(store.state, owner)?.status === "joined")
      && current.state?.phase === "streaming" && current.state.screen === "active"
      && current.state.bindingId === identity.bindingId && current.state.geometryRevision === identity.geometryRevision;
  }, [tabId, streamGeneration, instanceId]);
  const isCurrentInput = useCallback((identity: InputIdentity): boolean =>
    isCurrent(identity) && useStore.getState().rpc[tabId]?.devicePane.state?.inputReady === true,
  [isCurrent, tabId]);

  useEffect(() => {
    if (ensure === "idle" && !instanceDown) void ensureDevicePane(tabId);
  }, [ensure, instanceDown, tabId, ensureDevicePane]);

  useEffect(() => {
    paintedRef.current = null;
    paintedGeneration.current = -1;
    setPainted(null);
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (!active || instanceDown || !paintReady || canvas === null) return;
    const painter = createFramePainter<DevicePaneFrameHeader>(canvas, (header) => {
      paintedRef.current = header;
      paintedGeneration.current = streamGeneration;
      setPainted((previous) => previous?.bindingId === header.bindingId && previous.geometryRevision === header.geometryRevision
        && previous.width === header.width && previous.height === header.height && previous.dsf === header.dsf ? previous : header);
      noteDevicePaneFrame(tabId, header);
    }, decodeDevicePaneFrame, undefined, isCurrent);
    const unregister = registerDevicePaneWriter(tabId, (bytes) => painter.write(bytes));
    // State and frame channels can arrive out of order. Reuse the subscription
    // identity to replay the cached frame without restarting capture.
    backend.devicePaneSubscribe(tabId, viewedClientId(), true);
    return () => { paintedRef.current = null; paintedGeneration.current = -1; unregister(); painter.dispose(); };
  }, [tabId, active, instanceDown, paintReady, state?.bindingId, state?.geometryRevision, streamGeneration, noteDevicePaneFrame, isCurrent]);

  // Hidden tabs never subscribe; reconnect requires an entirely new painted identity.
  useEffect(() => {
    if (!active || instanceDown || !available) return;
    const clientId = viewedClientId();
    backend.devicePaneSubscribe(tabId, clientId, true);
    return () => backend.devicePaneSubscribe(tabId, clientId, false);
  }, [tabId, active, instanceDown, available]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setBox((previous) => previous?.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (attachedAt === 0) return;
    const timer = setTimeout(() => setAttachedAt(0), ATTACHED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [attachedAt]);
  useLayoutEffect(() => {
    if (!menuOpen) { setMenuMaxHeight(undefined); return; }
    const place = (): void => {
      const trigger = menuTrigger.current;
      if (trigger === null) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      setMenuMaxHeight(Math.max(0, bottom - Math.max(top, trigger.getBoundingClientRect().bottom) - 12));
    };
    place();
    const observer = new ResizeObserver(place);
    if (menuRef.current !== null) observer.observe(menuRef.current);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("transitionend", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("transitionend", place);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
  }, [menuOpen]);

  const send = useCallback((event: DevicePaneInputEvent) => backend.devicePaneInput(tabId, event), [tabId]);
  const releaseAll = useCallback(() => {
    if (moveFrame.current !== 0) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    pendingMoves.current.clear();
    for (const { slot, x, y, bindingId, geometryRevision } of pointers.current.values()) send({ type: "touch", phase: "up", x, y, pointer: slot, bindingId, geometryRevision });
    pointers.current.clear();
    for (const [key, identity] of keys.current) send({ type: "key", phase: "up", key, ...identity });
    keys.current.clear();
    composition.current = null;
  }, [send]);
  useEffect(() => releaseAll, [releaseAll, live, state?.bindingId, state?.geometryRevision, streamGeneration]);

  const currentInputIdentity = (): DevicePaneFrameHeader | null => {
    const identity = paintedRef.current;
    const currentFrame = useStore.getState().rpc[tabId]?.devicePane.frame;
    return identity !== null && paintedGeneration.current === streamGeneration && currentFrame?.bindingId === identity.bindingId
      && currentFrame.geometryRevision === identity.geometryRevision && isCurrentInput(identity) ? identity : null;
  };
  const sendLive = (event: InputPayload): void => {
    const identity = currentInputIdentity();
    if (identity !== null) send({ ...event, bindingId: identity.bindingId, geometryRevision: identity.geometryRevision });
  };
  const flushMoves = (): void => {
    moveFrame.current = 0;
    const identity = currentInputIdentity();
    for (const move of pendingMoves.current.values()) {
      if (identity?.bindingId === move.bindingId && identity.geometryRevision === move.geometryRevision) send(move);
    }
    pendingMoves.current.clear();
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    event.preventDefault();
    proxyRef.current?.focus({ preventScroll: true });
    const identity = currentInputIdentity();
    if (!live || identity === null || (event.pointerType === "mouse" && event.button !== 0) || pointers.current.has(event.pointerId)) return;
    const used = new Set([...pointers.current.values()].map((pointer) => pointer.slot));
    let slot = -1;
    for (let i = 0; i < POINTER_SLOTS; i++) if (!used.has(i)) { slot = i; break; }
    if (slot === -1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = unitPoint(event.currentTarget, event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    const held = { slot, x, y, bindingId: identity.bindingId, geometryRevision: identity.geometryRevision };
    pointers.current.set(event.pointerId, held);
    send({ type: "touch", phase: "down", x, y, pointer: slot, bindingId: held.bindingId, geometryRevision: held.geometryRevision });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const held = pointers.current.get(event.pointerId);
    const identity = currentInputIdentity();
    if (held === undefined || !live || identity?.bindingId !== held.bindingId || identity.geometryRevision !== held.geometryRevision) return;
    const { x, y } = unitPoint(event.currentTarget, event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    held.x = x; held.y = y;
    pendingMoves.current.set(held.slot, { type: "touch", phase: "move", x, y, pointer: held.slot, bindingId: held.bindingId, geometryRevision: held.geometryRevision });
    if (moveFrame.current === 0) moveFrame.current = requestAnimationFrame(flushMoves);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const held = pointers.current.get(event.pointerId);
    if (held === undefined) return;
    pointers.current.delete(event.pointerId);
    pendingMoves.current.delete(held.slot);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = event.type === "pointercancel" || !isCurrentInput(held) ? held : unitPoint(event.currentTarget, event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    send({ type: "touch", phase: "up", x: point.x, y: point.y, pointer: held.slot, bindingId: held.bindingId, geometryRevision: held.geometryRevision });
  };
  const onWheel = useRef<(event: WheelEvent) => void>(() => {});
  onWheel.current = (event) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!live || canvas === null) return;
    const dx = wheelDelta(event.deltaX, event.deltaMode);
    const dy = wheelDelta(event.deltaY, event.deltaMode);
    if (dx === 0 && dy === 0) return;
    sendLive({ type: "wheel", ...unitPoint(canvas, event.offsetX, event.offsetY), dx, dy });
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const listener = (event: WheelEvent): void => onWheel.current(event);
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, []);

  const sendText = (text: string): void => { for (const chunk of textChunks(text)) sendLive({ type: "text", text: chunk }); };
  const onBeforeInput = useRef<(event: InputEvent) => void>(() => {});
  onBeforeInput.current = (event) => {
    if (event.isComposing || (event.inputType !== "insertText" && event.inputType !== "insertFromPaste")) return;
    event.preventDefault();
    if (live && event.data) sendText(event.data);
  };
  useEffect(() => {
    const proxy = proxyRef.current;
    if (proxy === null) return;
    const listener = (event: InputEvent): void => onBeforeInput.current(event);
    proxy.addEventListener("beforeinput", listener);
    return () => proxy.removeEventListener("beforeinput", listener);
  }, []);
  const onCompositionEnd = (event: CompositionEvent<HTMLInputElement>): void => {
    const original = composition.current;
    composition.current = null;
    if (live && original !== null && isCurrentInput(original) && event.data) sendText(event.data);
    event.currentTarget.value = "";
  };
  const onKey = (keyPhase: "down" | "up", event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (keyPhase === "up") {
      const identity = keys.current.get(event.key);
      keys.current.delete(event.key);
      if (identity !== undefined) {
        event.preventDefault();
        send({ type: "key", phase: "up", key: event.key, ...identity });
      }
      return;
    }
    if (event.nativeEvent.isComposing || isAppHotkey(event.nativeEvent) || FORWARDED_KEYS[event.key] !== true) return;
    event.preventDefault();
    const identity = currentInputIdentity();
    if (!live || identity === null) return;
    keys.current.set(event.key, { bindingId: identity.bindingId, geometryRevision: identity.geometryRevision });
    sendLive({ type: "key", phase: "down", key: event.key });
  };
  const pressButton = (button: DeviceButton): void => { if (live) sendLive({ type: "button", button }); };
  const refresh = async (): Promise<void> => {
    if (available) await actDevicePane(tabId, { action: "refresh", bindingId: state?.bindingId ?? null });
    await ensureDevicePane(tabId);
  };
  const attach = (): void => {
    const canvas = canvasRef.current;
    const identity = currentInputIdentity();
    if (canvas === null || !live || identity === null) return;
    const url = canvas.toDataURL("image/jpeg");
    const comma = url.indexOf(",");
    if (comma === -1 || currentInputIdentity() !== identity) return;
    queueComposerAttachment(tabId, { type: "image", data: url.slice(comma + 1), mimeType: "image/jpeg" }, t("device.attachment.label", { avd: state?.avd ?? "", serial: state?.serial ?? "" }));
    setAttachedAt(Date.now());
  };
  const rotate = (rotation: EmulatorRotation): void => {
    closeMenu();
    if (controlsDisabled || state?.bindingId == null || state.capabilities.rotation.available !== true) return;
    releaseAll();
    void actDevicePane(tabId, { action: "rotate", bindingId: state.bindingId, rotation });
  };
  const setPosture = (posture: EmulatorPosture): void => {
    closeMenu();
    if (controlsDisabled || state?.bindingId == null || !state.capabilities.postures.available || !state.capabilities.postures.supported.some((entry) => entry.posture === posture)) return;
    releaseAll();
    void actDevicePane(tabId, { action: "set-posture", bindingId: state.bindingId, posture });
  };
  const rotationAvailable = state?.capabilities.rotation.available === true && state.rotation !== null;
  const supportedPostures = POSTURES.filter((posture) => state?.capabilities.postures.available === true
    && state.capabilities.postures.supported.some((entry) => entry.posture === posture));
  const foldedEndpoint = supportedPostures.includes("closed") ? "closed" : supportedPostures.includes("flipped") ? "flipped" : null;
  const foldTarget = state?.posture === "open" ? foldedEndpoint : "open";
  const foldAvailable = foldTarget !== null && supportedPostures.includes(foldTarget);
  const narrow = box === null || box.width < 420;
  const rotationReason = state?.capabilities.rotation.reason ?? t("device.controls.unavailable");
  const postureReason = state?.capabilities.postures.reason ?? t("device.controls.unavailable");
  const target = inventory?.targets.find((entry) => entry.serial === state?.serial && entry.avd === state?.avd);

  let status: string | null = null;
  if (ensure === "idle" || ensure === "pending") status = t("device.state.pending");
  else if (ensure === "update-required") status = t("device.state.updateRequired");
  else if (ensure === "not-live") status = t("device.state.notLive");
  else if (state?.operation?.stage === "creating" || phase === "provisioning") status = t("device.state.creating", { avd: state?.operation?.avd ?? state?.avd ?? "" });
  else if (state?.operation?.stage === "rotating") status = t("device.state.rotating");
  else if (state?.operation?.stage === "changing-posture") status = t("device.state.changingPosture");
  else if (state?.operation?.stage === "starting" || phase === "booting") status = t("device.state.booting", { avd: state?.operation?.avd ?? state?.avd ?? "" });
  else if (state?.operation?.stage === "connecting" || phase === "connecting") status = t("device.state.connecting", { avd: state?.operation?.avd ?? state?.avd ?? state?.serial ?? "" });
  else if (inventory?.sdk.status === "missing") status = t("device.state.sdkMissing", { missing: inventory.sdk.missing.join(", ") });
  else if (phase === "error") status = state?.error ?? t("device.state.error");
  else if (state?.screen === "inactive") status = t("device.state.screenInactive");
  else if (phase === "unbound") status = t((inventory?.targets.length ?? 0) === 0 ? "device.state.noTargets" : "device.state.unbound");
  else if (!showFrame) status = t("device.state.noFrames");
  const lifecycle = status ?? t("hud.status.ready");
  const subtitle = [instanceId === null ? null : ownerName, target?.api == null ? null : t("device.picker.api", { api: target.api }),
    lifecycle, state?.agent === "attached" ? t("device.agent.attached") : null].filter(Boolean).join(" · ");
  let canvasSize: { width: number; height: number } | undefined;
  if (painted !== null && box !== null && box.width > 0 && box.height > 0) {
    const scale = Math.min(box.width / painted.width, box.height / painted.height);
    canvasSize = { width: Math.floor(painted.width * scale), height: Math.floor(painted.height * scale) };
  }
  const confirmationCurrent = confirmPowerOff !== null && confirmPowerOff.bindingId === state?.bindingId && bound && !busy;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      {acting && <div aria-hidden className="pointer-events-none absolute inset-0 z-10 animate-pulse border border-copper motion-reduce:animate-none" />}
      <header className="relative z-20 shrink-0 border-b border-line bg-sunken">
        <div className="flex min-w-0 items-center px-1">
          <button type="button" aria-haspopup="dialog" aria-expanded={pickerOpen} aria-label={t("device.toolbar.target")}
            disabled={instanceDown || !available} onClick={() => setPickerOpen(true)}
            className="min-h-11 min-w-0 flex-1 rounded-md px-2 py-1 text-left hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong disabled:text-ink-faint">
            <span className="block truncate text-sm font-medium text-ink">{target?.friendlyName ?? state?.avd ?? state?.serial ?? t("device.toolbar.choose")}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span role="status" title={subtitle} className="min-w-0 flex-1 truncate text-xs text-ink-dim">{subtitle}</span>
              {acting && <span role="status" className="shrink-0 rounded border border-copper/30 px-1 text-xs text-copper">{t("device.agent.acting")}</span>}
            </span>
          </button>
          {!narrow && <span className="relative shrink-0">
            <IconButton label={t("device.toolbar.attach")} disabled={!live} onClick={attach} className={CONTROL_CLASS}><IconAttach /></IconButton>
          </span>}
          {attachedAt !== 0 && <span role="status" className="pointer-events-none absolute right-0 top-full z-30 rounded-md border border-line bg-overlay px-2 py-1 text-xs text-ink-mid">{t("device.toolbar.attached")}</span>}
          {placement !== "sheet" && <>
            {!narrow && <IconButton label={placement === "column" ? t("device.toolbar.split") : t("device.toolbar.fullscreen")} disabled={forcedColumn}
              onClick={() => setDevicePaneFullscreen(tabId, placement !== "column")} className={CONTROL_CLASS}>{placement === "column" ? <IconSplit /> : <IconFullscreen />}</IconButton>}
            <IconButton label={t("device.toolbar.close")} onClick={() => closeDevicePane(tabId)} className={CONTROL_CLASS}><IconClose className="size-3" /></IconButton>
          </>}
            <div ref={menuRoot} className="relative shrink-0">
              <button ref={menuTrigger} type="button" aria-label={t("device.toolbar.more")} title={t("device.toolbar.more")} aria-haspopup="menu" aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)} className="grid size-11 place-items-center rounded-md text-ink-dim hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong"><IconMore /></button>
              {menuOpen && <div ref={menuRef} role="menu" aria-label={t("device.toolbar.more")}
                style={menuMaxHeight === undefined ? undefined : { maxHeight: `min(32rem, ${menuMaxHeight}px)` }}
                className="absolute right-0 top-full z-30 mt-1 flex max-h-[min(32rem,60dvh)] w-[min(18rem,calc(100vw-1rem))] flex-col overflow-y-auto rounded-md border border-line-strong bg-overlay p-1 shadow-lg [&_button]:min-h-11"
                onKeyDown={(event) => {
                  const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [])];
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  if (event.key === "Tab") { closeMenu(); return; }
                  const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
                  if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
                }}>
                {narrow && <>
                  <MenuRow glyph={<IconAttach />} label={t("device.toolbar.attach")} disabled={!live} onClick={() => { closeMenu(); attach(); }} />
                  {placement !== "sheet" && <MenuRow glyph={placement === "column" ? <IconSplit /> : <IconFullscreen />} label={t(placement === "column" ? "device.toolbar.split" : "device.toolbar.fullscreen")} disabled={forcedColumn}
                    onClick={() => { closeMenu(); setDevicePaneFullscreen(tabId, placement !== "column"); }} />}
                </>}
                <MenuRow glyph={<IconRefresh />} label={t("device.toolbar.refresh")} disabled={instanceDown || busy} onClick={() => { closeMenu(); void refresh(); }} />
                <Label className="px-2 pb-1 pt-2">{t("device.toolbar.rotationHeading")}</Label>
                {!rotationAvailable && <p className="px-2 text-xs text-ink-dim">{rotationReason}</p>}
                {([0, 1, 2, 3] as const).map((rotation) => <MenuRow key={rotation} label={t("device.toolbar.rotation", { degrees: rotation * 90 })} hint={state?.rotation === rotation ? "✓" : undefined}
                  disabled={controlsDisabled || !rotationAvailable} onClick={() => rotate(rotation)} />)}
                <Label className="px-2 pb-1 pt-2">{t("device.toolbar.postures")}</Label>
                {supportedPostures.length === 0 && <p className="px-2 text-xs text-ink-dim">{postureReason}</p>}
                {supportedPostures.map((posture) => <MenuRow key={posture} label={t(`device.posture.${posture}`)} hint={state?.posture === posture ? "✓" : undefined}
                  disabled={controlsDisabled} onClick={() => setPosture(posture)} />)}
                {target?.layoutReference && <p className="px-2 py-2 text-xs text-ink-dim">{t("device.picker.layoutReference", { name: target.layoutReference })} · {t("device.picker.screenSizeOnly")}</p>}
                <div className="my-1 border-t border-line" />
                <MenuRow label={t("device.toolbar.disconnect")} disabled={!bound || busy} onClick={() => {
                  closeMenu();
                  if (state?.bindingId == null) return;
                  releaseAll();
                  void actDevicePane(tabId, { action: "unbind", bindingId: state.bindingId });
                }} />
                <MenuRow glyph={<IconPower />} label={t("device.toolbar.powerOff")} disabled={!bound || busy} onClick={() => {
                  closeMenu();
                  if (state?.bindingId != null) setConfirmPowerOff({ bindingId: state.bindingId, avd: state.avd ?? state.serial ?? "" });
                }} />
              </div>}
            </div>
        </div>
        <div className={cn("flex min-w-0 border-t border-line px-1", narrow ? "flex-col items-stretch" : "items-center justify-between")} role="toolbar" aria-label={t("device.surface.label")}>
          <div className="flex shrink-0">
            <IconButton label={t("device.toolbar.back")} disabled={!live} onClick={() => pressButton("back")} className={CONTROL_CLASS}><IconBack /></IconButton>
            <IconButton label={t("device.toolbar.home")} disabled={!live} onClick={() => pressButton("home")} className={CONTROL_CLASS}><IconHome /></IconButton>
            <IconButton label={t("device.toolbar.recents")} disabled={!live} onClick={() => pressButton("recents")} className={CONTROL_CLASS}><IconRecents /></IconButton>
          </div>
          <div className={cn("flex min-w-0 items-center", narrow ? "border-t border-line" : "border-l border-line pl-0.5")}>
            <IconButton label={rotationAvailable ? t("device.toolbar.rotateLeft") : `${t("device.toolbar.rotateLeft")}: ${rotationReason}`} disabled={controlsDisabled || !rotationAvailable}
              onClick={() => { if (state?.rotation != null) rotate(((state.rotation + 1) % 4) as EmulatorRotation); }} className={CONTROL_CLASS}><IconRotate /></IconButton>
            <IconButton label={rotationAvailable ? t("device.toolbar.rotateRight") : `${t("device.toolbar.rotateRight")}: ${rotationReason}`} disabled={controlsDisabled || !rotationAvailable}
              onClick={() => { if (state?.rotation != null) rotate(((state.rotation + 3) % 4) as EmulatorRotation); }} className={CONTROL_CLASS}><IconRotate right /></IconButton>
            {supportedPostures.length > 0 && <>
              <button type="button" aria-label={t(foldTarget === "open" ? "device.toolbar.unfold" : "device.toolbar.fold")}
                disabled={controlsDisabled || !foldAvailable} onClick={() => { if (foldTarget !== null) setPosture(foldTarget); }}
                className="flex min-h-11 min-w-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 text-xs text-ink-dim hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong disabled:opacity-50">
                <IconFold />{state?.posture != null && t(`device.posture.${state.posture}`)}
              </button>
              <select aria-label={t("device.toolbar.postures")} value={state?.posture ?? ""} disabled={controlsDisabled}
                onChange={(event) => setPosture(event.target.value as EmulatorPosture)}
                className="min-h-11 w-0 min-w-11 flex-1 rounded-md border border-line bg-sunken px-1 text-xs text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong">
                {!supportedPostures.includes(state?.posture as EmulatorPosture) && <option value="" disabled>{t("device.toolbar.postures")}</option>}
                {supportedPostures.map((posture) => <option key={posture} value={posture}>{t(`device.posture.${posture}`)}</option>)}
              </select>
            </>}
          </div>
        </div>
      </header>
      {state?.actionError && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-line bg-sunken px-3 py-2 text-xs">
        <p className="min-w-0 flex-1 basis-full break-words text-rose">{state.actionError}</p>
        <Button onClick={() => void refresh()} disabled={instanceDown || busy} className="min-h-11">{t("device.toolbar.refresh")}</Button>
        <Button onClick={() => setPickerOpen(true)} disabled={instanceDown || !available || busy} className="min-h-11">{t("device.toolbar.choose")}</Button>
      </div>}
      <div ref={hostRef} tabIndex={0} role="group" aria-label={t("device.surface.label")}
        onFocus={(event) => { if (event.target === event.currentTarget) proxyRef.current?.focus({ preventScroll: true }); }}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-void outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-line-strong">
        <canvas ref={canvasRef} style={{ ...canvasSize, visibility: showFrame ? "visible" : "hidden" }} className={cn("block touch-none", live ? "cursor-default" : "cursor-not-allowed")}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onContextMenu={(event) => event.preventDefault()} />
        <input ref={proxyRef} type="text" aria-hidden tabIndex={-1} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="pointer-events-none absolute left-0 top-0 size-px opacity-0" onKeyDown={(event) => onKey("down", event)} onKeyUp={(event) => onKey("up", event)}
          onBlur={releaseAll} onPaste={(event) => { event.preventDefault(); if (live) sendText(event.clipboardData.getData("text")); }}
          onCompositionStart={() => { composition.current = live ? currentInputIdentity() : null; }} onCompositionEnd={onCompositionEnd} />
        {(instanceDown || status !== null) && <div role="status" className="absolute inset-x-4 top-1/2 flex -translate-y-1/2 flex-col items-center gap-3 text-center text-xs leading-relaxed text-ink-dim">
          <p>{instanceDown ? t("device.state.instanceDown") : status}</p>
          {available && !instanceDown && phase === "unbound" && <Button onClick={() => setPickerOpen(true)} className="min-h-11">{t("device.toolbar.choose")}</Button>}
          {!instanceDown && phase === "error" && <Button onClick={() => void refresh()} disabled={busy} className="min-h-11">{t("device.toolbar.refresh")}</Button>}
        </div>}
      </div>
      {pickerOpen && <DevicePicker inventory={inventory} state={state} ownerName={ownerName} disabled={instanceDown || !available}
        onAction={(action) => { releaseAll(); void actDevicePane(tabId, action); }} onRefresh={() => void refresh()} onClose={() => setPickerOpen(false)} />}
      {confirmPowerOff !== null && <ConfirmDialog kicker={t("device.powerOff.kicker")} title={t("device.powerOff.title", { avd: confirmPowerOff.avd })} tone="rose"
        onClose={() => setConfirmPowerOff(null)} actions={<>
          <Button onClick={() => setConfirmPowerOff(null)} className="min-h-11">{t("common.dialog.cancel")}</Button>
          <Button tone="rose" disabled={!confirmationCurrent} className="min-h-11" onClick={() => {
            const captured = confirmPowerOff;
            setConfirmPowerOff(null);
            const current = useStore.getState().rpc[tabId]?.devicePane.state;
            if (current == null || captured.bindingId !== current.bindingId || current.operation !== null || current.agent === "acting" || instanceDown) return;
            releaseAll();
            void actDevicePane(tabId, { action: "power-off", bindingId: captured.bindingId });
          }}>{t("device.powerOff.confirm")}</Button>
        </>}>
        <p className="text-xs leading-relaxed text-ink-mid">{t("device.powerOff.body")}</p>
        {!confirmationCurrent && <p role="status" className="mt-3 text-xs text-rose">{t("device.powerOff.changed")}</p>}
      </ConfirmDialog>}
    </div>
  );
}
