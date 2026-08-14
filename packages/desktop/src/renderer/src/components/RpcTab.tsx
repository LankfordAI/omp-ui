import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import { preExchange, type RenderItem } from "../lib/transcript";
import { findRecord, useStore, type RpcFailure } from "../store";
import { Composer } from "./Composer";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { ExtensionDialogHost } from "./ExtensionDialogHost";
import { InspectorRail } from "./InspectorRail";
import { PlanReview } from "./PlanReview";
import { SessionHud } from "./SessionHud";
import { TranscriptView } from "./TranscriptView";
import { Button, Chip, CopyButton, Panel, ProgressSweep } from "./ui";

const NO_ITEMS: never[] = [];

/** Boot placeholder — an empty pane reads as a hang, three bars read as work. */
function TranscriptSkeleton() {
  return (
    <div className="animate-rise flex flex-1 flex-col gap-3 px-5 py-4">
      {[0.62, 0.9, 0.44].map((width, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-line-soft"
          style={{ width: `${width * 100}%`, animationDelay: `${i * 140}ms` }}
        />
      ))}
    </div>
  );
}

/** The fresh-session greeting above the centered composer. */
function HeroGreeting({ projectCwd }: { projectCwd: string | undefined }) {
  const project = projectCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return (
    <div className="animate-rise flex min-h-0 flex-1 flex-col items-center justify-end gap-2 px-6 pb-6">
      <h1 className="text-balance-tight text-center font-display text-3xl text-ink">
        {project ? `What's next in ${project}?` : "What's next?"}
      </h1>
      <p className="text-sm text-ink-dim">
        Describe it — plan first, or build straight away.
      </p>
    </div>
  );
}

/** Ambient pre-exchange items (boot notices, markers), quiet, below the hero card. */
function HeroFooter({ items }: { items: RenderItem[] }) {
  return (
    <div className="flex min-h-0 flex-[0.85] flex-col items-center gap-1 overflow-y-auto px-6 pt-4">
      {items.map((item) =>
        item.kind === "notice" ? (
          <p
            key={item.id}
            data-selectable
            className={cn(
              "max-w-3xl text-center font-mono text-[11px]",
              item.level === "error"
                ? "text-rose"
                : item.level === "warn"
                  ? "text-copper"
                  : "text-ink-faint",
            )}
          >
            {item.text}
          </p>
        ) : item.kind === "marker" ? (
          <p
            key={item.id}
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint"
          >
            {item.label}
          </p>
        ) : null,
      )}
    </div>
  );
}

export function RpcTab({ tabId, active }: { tabId: string; active: boolean }) {
  const rpc = useStore((s) => s.rpc[tabId]);
  const bootRpcTab = useStore((s) => s.bootRpcTab);
  const refreshState = useStore((s) => s.refreshState);
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);
  const compact = useCompactShell();
  const [dismissedFailure, setDismissedFailure] = useState<RpcFailure | null>(null);

  useEffect(() => {
    if (!rpc) void bootRpcTab(tabId);
  }, [rpc, tabId, bootRpcTab]);

  const status = rpc?.status ?? "starting";
  const failure = rpc?.failure && rpc.failure !== dismissedFailure ? rpc.failure : null;
  const failureText = failure ? `${failure.message}\n\n${failure.recovery}` : "";
  // `busy` is ref-counted off in-flight rpc commands, so the sweep is honest for
  // any blocking round-trip (compact, export, branch), not just boot.
  const working = status === "starting" || (rpc?.busy ?? false);
  const items = rpc?.items ?? NO_ITEMS;
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd);
  /** Latched on the first local prompt: the hero docks now, not a round-trip later. */
  const [prompted, setPrompted] = useState(false);
  // A reboot (resume, advisor relaunch, lineage switch) passes through
  // "starting" and resets items — re-arm the latch with them.
  useEffect(() => {
    if (status === "starting") setPrompted(false);
  }, [status]);

  const hero =
    !compact &&
    exitCode === undefined &&
    status === "ready" &&
    !prompted &&
    preExchange(items);

  const slotRef = useRef<HTMLDivElement | null>(null);
  const heroRect = useRef<DOMRect | null>(null);
  const wasHero = useRef(false);

  // FLIP: while the hero shows, remember where the composer sits (this commit's
  // layout is the "first" frame of a future flip). On the commit that docks it,
  // the DOM is already in the final layout — play the inverted delta back to
  // zero. Runs every commit by design; hero commits are rare (boot patches).
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (hero && slot) heroRect.current = slot.getBoundingClientRect();
    if (wasHero.current && !hero && slot && heroRect.current) {
      const to = slot.getBoundingClientRect();
      const dy = heroRect.current.top - to.top;
      heroRect.current = null;
      if (
        dy !== 0 &&
        to.width > 0 && // hidden tab (display:none) measures 0 — skip
        typeof slot.animate === "function" && // jsdom has no WAAPI
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        slot.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
          { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }
    wasHero.current = hero;
  });

  // A resize during the hero moves the composer without a re-render; keep the
  // remembered rect honest so a flip right after a resize starts in place.
  useEffect(() => {
    if (!hero) return;
    const capture = () => {
      if (slotRef.current) heroRect.current = slotRef.current.getBoundingClientRect();
    };
    window.addEventListener("resize", capture);
    return () => window.removeEventListener("resize", capture);
  }, [hero]);

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {compact && <SessionHud tabId={tabId} />}

      {/* Flush with the tab pane's top edge, never in flow: a 1px bar that
          mounts/unmounts in flow shifts the whole transcript and jitters it.
          On desktop that edge is the hairline under the merged title bar; in
          the compact shell it remains the HUD's bottom border. The -top-px
          mechanics are unchanged either way. */}
      {working && (
        <div className="relative z-10 h-0">
          <div className="absolute inset-x-0 -top-px">
            <ProgressSweep tone={status === "starting" ? "neutral" : "signal"} />
          </div>
        </div>
      )}

      {failure && (
        <div className="px-3 pt-2">
          <Panel tone="rose" className="animate-rise flex items-start gap-2 px-2.5 py-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] leading-snug text-rose">
              {failureText}
            </p>
            <CopyButton text={failureText} label="Copy" />
            {failure.kind === "boot" && (
              <Button size="xs" variant="ghost" tone="rose" onClick={() => void bootRpcTab(tabId)}>
                Retry boot
              </Button>
            )}
            {!failure.fatal && (
              <>
                <Button size="xs" variant="ghost" tone="rose" onClick={() => void refreshState(tabId)}>
                  Refresh state
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  tone="rose"
                  onClick={() => setDismissedFailure(failure)}
                >
                  Dismiss
                </Button>
              </>
            )}
          </Panel>
        </div>
      )}

      {/* The console drawer spans the full tab width — transcript column and
          rail — docked at the bottom edge below the composer (issue #33). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {status === "starting" && items.length === 0 ? (
              <TranscriptSkeleton />
            ) : hero ? (
              <HeroGreeting projectCwd={projectCwd} />
            ) : (
              <TranscriptView items={items} />
            )}
            {/* Docked, not modal: the user may need to scroll the transcript to
                answer, so the question must not cover it. */}
            <ExtensionDialogHost tabId={tabId} />
            <div ref={slotRef} className={cn(hero && "pb-2")}>
              <Composer tabId={tabId} onPrompt={() => setPrompted(true)} />
            </div>
            {hero && <HeroFooter items={items} />}
          </div>
          <InspectorRail tabId={tabId} />
        </div>
        <ConsoleDrawer tabId={tabId} />
      </div>

      {/* Only the focused tab's review may overlay the screen — a background
          session's pending plan lives in the rail's plans tab until revisited. */}
      {active && <PlanReview tabId={tabId} />}

      {exitCode !== undefined && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/80 backdrop-blur-sm">
          <Panel className="edge-lit animate-rise flex flex-col items-center gap-3 px-8 py-6">
            <p className="font-display text-sm text-ink">Agent exited</p>
            <Chip tone="rose" mono title={`process exit code ${exitCode}`}>
              exit {exitCode}
            </Chip>
            <Button variant="solid" tone="signal" onClick={() => void resumeDead(tabId)}>
              resume session
            </Button>
          </Panel>
        </div>
      )}
    </div>
  );
}
