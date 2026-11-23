import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoutinesState } from "@omp-ui/core/routine";
import type { ProjectGroup, RemoteInstanceSummary } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { isRoutineRun } from "../../lib/sidebar-sessions";
import { useDismissal } from "../../lib/use-dismissal";
import { useStore } from "../../store";
import { Chevron, Dot, ICON_STROKE, Label, Panel, type Tone } from "../ui";

function waitingApprovalCount(
  projects: readonly ProjectGroup[] | undefined,
  routinesState: RoutinesState | null | undefined,
): number {
  const fromRuns = routinesState?.runs.filter((r) => r.outcome === "waiting-approval").length ?? 0;
  if (fromRuns > 0) return fromRuns;
  let count = 0;
  for (const group of projects ?? []) {
    for (const s of group.sessions) {
      if (s.live === "live" && isRoutineRun(s) && s.awaitingHumanAnswer === true) count += 1;
    }
  }
  return count;
}

function isUnsupportedError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith("unknown channel");
}

function hostDotTone(
  enabled: boolean,
  status: RemoteInstanceSummary["status"] | "local",
  loadError: string | null | undefined,
): Tone {
  if (status === "local") return enabled ? "signal" : "copper";
  if (status !== "joined") return "rose";
  if (isUnsupportedError(loadError)) return "copper";
  return enabled ? "signal" : "copper";
}

function remoteStatusSubtitle(instance: RemoteInstanceSummary, loadError: string | null | undefined): string {
  if (instance.status === "connecting") return "Connecting…";
  if (instance.status === "unreachable") return "Unreachable";
  if (instance.status === "needs-sign-in") return "Sign in required";
  if (instance.status === "incompatible") return "Incompatible version";
  if (isUnsupportedError(loadError)) return `Unsupported · ${instance.url}`;
  if (instance.routinesEnabled !== true) return `Routines off · ${instance.url}`;
  return instance.url;
}

function remoteBadge(
  instance: RemoteInstanceSummary,
  snapshot: RoutinesState | undefined,
  loadError: string | null | undefined,
  waiting: number,
): { label: string; tone: "copper" | "rose" | "neutral" } {
  if (instance.status === "connecting") return { label: "Connecting", tone: "neutral" };
  if (instance.status === "unreachable") return { label: "Offline", tone: "rose" };
  if (instance.status === "needs-sign-in") return { label: "Sign in", tone: "rose" };
  if (instance.status === "incompatible") return { label: "Old version", tone: "rose" };
  if (isUnsupportedError(loadError)) return { label: "Unsupported", tone: "neutral" };
  if (instance.routinesEnabled !== true) return { label: "Off", tone: "neutral" };
  if (waiting > 0) return { label: `${waiting} approval`, tone: "copper" };
  if (snapshot !== undefined) {
    const enabledCount = snapshot.routines.filter((r) => r.enabled).length;
    return { label: `${enabledCount}/${snapshot.routines.length}`, tone: "neutral" };
  }
  return { label: "On", tone: "neutral" };
}

/**
 * Top-bar host switcher for the Routines view (ADR-0100 §8 amendment, #1306).
 * Renders plain text ("Routines on <host>") when zero non-`self` remote
 * instances are configured, and a `[app-region:no-drag]` dropdown trigger when
 * one or more remote instances exist. Used in wide TitleBar, compact header,
 * and collapsed-sidebar header.
 */
export function RoutinesHostMenu({ className }: { className?: string }) {
  const state = useStore((s) => s.state);
  const routinesInstanceId = useStore((s) => s.routinesInstanceId);
  const routinesState = useStore((s) => s.routinesState);
  const routinesByInstance = useStore((s) => s.routinesByInstance);
  const routinesLoadError = useStore((s) => s.routinesLoadError);
  const selectRoutinesHost = useStore((s) => s.selectRoutinesHost);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const remotes = useMemo(
    () => (state?.remoteInstances ?? []).filter((i) => i.status !== "self"),
    [state?.remoteInstances],
  );

  const localLabel = routinesState?.machineLabel ?? "this computer";
  const activeRemote =
    routinesInstanceId === null ? null : (remotes.find((i) => i.id === routinesInstanceId) ?? null);
  const activeLabel =
    routinesInstanceId === null
      ? localLabel
      : (activeRemote?.nickname ?? routinesByInstance[routinesInstanceId]?.machineLabel ?? routinesInstanceId);

  const close = () => setOpen(false);

  useDismissal({
    open,
    refs: [triggerRef, menuRef],
    onClose: close,
    onEscape: close,
    restoreFocus: () => triggerRef.current?.focus(),
  });

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ left: rect.left, top: rect.bottom + 4 });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Zero remote instances configured: plain text identical to pre-#1306 chrome.
  if (remotes.length === 0) {
    return (
      <span
        data-routines-host-plain
        className={cn("min-w-0 truncate text-sm text-ink-dim", className)}
      >
        {routinesState === null ? "Routines" : `Routines on ${localLabel}`}
      </span>
    );
  }

  const localEnabled = state?.routinesEnabled === true;
  const localWaiting = waitingApprovalCount(state?.projects, routinesState);
  const otherWaiting =
    (routinesInstanceId !== null ? localWaiting : 0) +
    remotes.reduce((sum, inst) => {
      if (inst.id === routinesInstanceId) return sum;
      return sum + waitingApprovalCount(inst.projects, routinesByInstance[inst.id]);
    }, 0);

  const activeTone =
    activeRemote === null
      ? hostDotTone(localEnabled, "local", null)
      : hostDotTone(
          activeRemote.routinesEnabled === true,
          activeRemote.status,
          routinesLoadError[activeRemote.id],
        );

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setPos(rect ? { left: rect.left, top: rect.bottom + 4 } : { left: 12, top: 40 });
    setOpen(true);
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(currentIndex + 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const pickHost = (id: string | null) => {
    selectRoutinesHost(id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const localEnabledCount = routinesState?.routines.filter((r) => r.enabled).length ?? 0;
  const localTotalCount = routinesState?.routines.length ?? 0;

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-sm text-ink-dim", className)}>
      <span className="shrink-0">Routines on</span>
      <button
        ref={triggerRef}
        type="button"
        data-routines-host-trigger
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Routines host: ${activeLabel}`}
        onClick={toggleMenu}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            toggleMenu();
          }
        }}
        className={cn(
          "inline-flex h-6 max-w-52 min-w-0 items-center gap-1.5 rounded-md border border-line bg-raised/75 px-2 text-xs font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover [app-region:no-drag]",
          open && "border-line-strong bg-hover",
        )}
      >
        <Dot tone={activeTone} />
        <span className="min-w-0 truncate">{activeLabel}</span>
        {otherWaiting > 0 && (
          <span
            data-routines-host-other-waiting
            title={`${otherWaiting} routine run waiting on approval on another host`}
            className="shrink-0 rounded-full bg-copper-wash px-1 font-mono text-[11px] leading-4 tabular-nums text-copper"
          >
            {otherWaiting}
          </span>
        )}
        <Chevron open={false} className={cn("size-3 shrink-0 text-ink-faint", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Routines host"
            data-routines-host-menu
            onKeyDown={handleMenuKeyDown}
            className="fixed z-50"
            style={{
              left: Math.max(8, Math.min(pos.left, Math.max(8, window.innerWidth - 280))),
              top: pos.top,
            }}
          >
            <Panel className="edge-lit animate-rise w-72 max-w-[calc(100vw-1rem)] p-1.5">
              <div className="px-2 pt-1 pb-1.5">
                <Label>Routines host</Label>
              </div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={routinesInstanceId === null}
                data-routines-host-option="local"
                onClick={() => pickHost(null)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus:bg-hover focus:outline-none",
                  routinesInstanceId === null && "bg-raised/85",
                )}
              >
                <Dot tone={hostDotTone(localEnabled, "local", null)} className="mt-0.5 self-start" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-ink">{localLabel}</span>
                  <span className="block truncate text-[11px] text-ink-faint">This computer</span>
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[11px] tabular-nums",
                    localWaiting > 0 ? "text-copper" : "text-ink-faint",
                  )}
                >
                  {!localEnabled
                    ? "Off"
                    : localWaiting > 0
                      ? `${localWaiting} approval`
                      : routinesState !== null
                        ? `${localEnabledCount}/${localTotalCount}`
                        : "On"}
                </span>
                <span className="flex size-3.5 shrink-0 items-center justify-center text-signal">
                  {routinesInstanceId === null && (
                    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" {...ICON_STROKE}>
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                  )}
                </span>
              </button>
              <div role="separator" className="my-1 h-px bg-line-soft" />
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {remotes.map((instance) => {
                  const snapshot = routinesByInstance[instance.id];
                  const loadError = routinesLoadError[instance.id];
                  const waiting = waitingApprovalCount(instance.projects, snapshot);
                  const badge = remoteBadge(instance, snapshot, loadError, waiting);
                  const selected = routinesInstanceId === instance.id;
                  return (
                    <button
                      key={instance.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      data-routines-host-option={instance.id}
                      onClick={() => pickHost(instance.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus:bg-hover focus:outline-none",
                        selected && "bg-raised/85",
                      )}
                    >
                      <Dot
                        tone={hostDotTone(instance.routinesEnabled === true, instance.status, loadError)}
                        className="mt-0.5 self-start"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-ink">{instance.nickname}</span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          {remoteStatusSubtitle(instance, loadError)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[11px] tabular-nums",
                          badge.tone === "copper"
                            ? "text-copper"
                            : badge.tone === "rose"
                              ? "text-rose"
                              : "text-ink-faint",
                        )}
                      >
                        {badge.label}
                      </span>
                      <span className="flex size-3.5 shrink-0 items-center justify-center text-signal">
                        {selected && (
                          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" {...ICON_STROKE}>
                            <path d="M3.5 8.5l3 3 6-7" />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Panel>
          </div>,
          document.body,
        )}
    </span>
  );
}
