import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import type { ContextUsage } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { ConsoleToggle } from "./ConsoleDrawer";
import { PlanToggle } from "./PlanToggle";
import { Button, Chip, Dot, IconButton, Label, Meter, Panel, Sheet, Switch, type Tone } from "./ui";

/**
 * The instrument's status bar: one line that answers "is it alive, what is it
 * called, how full is the context, and what can I do to it right now".
 *
 * On desktop the HUD renders inside App's merged title bar (issue #60); the
 * compact branch below is unchanged and still renders in-tab inside RpcTab.
 *
 * The numeric formatters and the two micro-controls below live here rather than
 * in `ui.tsx` (which Main owns) because only the RPC chrome consumes them.
 */

/* ------------------------------------------------------------- formatting */

/** `34900` → `34.9K`, `1000000` → `1M`. Exact values belong in `title=`. */
export function compactNum(value: number): string {
  const abs = Math.abs(value);
  const step: readonly [number, string] =
    abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  if (step[0] === 1) return `${Math.round(value)}`;
  const scaled = (value / step[0]).toFixed(1);
  return `${scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled}${step[1]}`;
}

/** Grouped digits for `title=` tooltips, where truncation would be a lie. */
export function exactNum(value: number): string {
  return value.toLocaleString("en-US");
}

/** Cost display precision is a product decision, shared by the HUD and the rail. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/* ---------------------------------------------------------------- controls */

interface SegmentOption {
  value: string;
  label: ReactNode;
  title?: string;
}

/** Small segmented control. Unknown current values are the caller's problem. */
function Segmented({
  value,
  options,
  onChange,
  className,
}: {
  value: string | null;
  options: SegmentOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      className={cn(
        "flex items-center gap-0.5 rounded-md border border-line bg-void p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title ?? option.value}
            aria-pressed={on}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-[10px] leading-4",
              "transition-colors duration-150",
              on ? "bg-raised text-ink" : "text-ink-dim hover:bg-hover hover:text-ink-mid",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- icons */

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)}>
      {children}
    </svg>
  );
}

function IconCompact() {
  return (
    <Svg>
      <path d="M8 1.5V6M5.5 3.5L8 6l2.5-2.5" {...S} />
      <path d="M8 14.5V10M5.5 12.5L8 10l2.5 2.5" {...S} />
      <path d="M2.5 8h11" {...S} />
    </Svg>
  );
}

function IconExport() {
  return (
    <Svg>
      <path d="M8 10.5V2M5 5l3-3 3 3" {...S} />
      <path d="M2.5 10v3.5h11V10" {...S} />
    </Svg>
  );
}

function IconBranch() {
  return (
    <Svg>
      <circle cx="4" cy="3.8" r="1.7" {...S} />
      <circle cx="4" cy="12.2" r="1.7" {...S} />
      <circle cx="11.8" cy="4.6" r="1.7" {...S} />
      <path d="M4 5.5v5.1M10.1 4.6H8.4A4.4 4.4 0 004 9v1.4" {...S} />
    </Svg>
  );
}

function IconNew() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="6" {...S} />
      <path d="M8 5.2v5.6M5.2 8h5.6" {...S} />
    </Svg>
  );
}

export function IconRefresh() {
  return (
    <Svg>
      <path d="M13.5 8a5.5 5.5 0 11-1.9-4.2" {...S} />
      <path d="M13.6 2v3.6H10" {...S} />
    </Svg>
  );
}

function IconSliders() {
  return (
    <Svg>
      <path d="M2 4.5h4.6M10.4 4.5H14M2 11.5h2.6M8.4 11.5H14" {...S} />
      <circle cx="8.5" cy="4.5" r="1.7" {...S} />
      <circle cx="6.5" cy="11.5" r="1.7" {...S} />
    </Svg>
  );
}

function IconMcp() {
  return (
    <Svg>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" {...S} />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" {...S} />
      <path d="M5 4.75h.01M5 11.25h.01" {...S} />
    </Svg>
  );
}

/* --------------------------------------------------------------- fragments */

const STATUS: Record<string, { tone: Tone; pulse: boolean }> = {
  starting: { tone: "neutral", pulse: true },
  ready: { tone: "signal", pulse: false },
  running: { tone: "copper", pulse: true },
  error: { tone: "rose", pulse: false },
};

/** Click-to-rename title. Enter commits; Escape and blur both abandon. */
function TitleField({ tabId, title }: { tabId: string; title: string }) {
  const renameSessionTo = useStore((s) => s.renameSessionTo);
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <button
        type="button"
        title={`${title} — click to rename`}
        onClick={() => setDraft(title)}
        className="min-w-0 truncate rounded px-1 py-0.5 text-left font-display text-[13px] text-ink transition-colors hover:bg-hover"
      >
        {title}
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      aria-label="session name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const name = draft.trim();
          setDraft(null);
          if (name && name !== title) void renameSessionTo(tabId, name);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
        }
      }}
      className="min-w-0 flex-1 rounded border border-line-strong bg-void px-1.5 py-0.5 font-display text-[13px] text-ink outline-none focus:border-signal-dim"
    />
  );
}

function ContextCluster({ usage }: { usage: ContextUsage }) {
  const window = usage.contextWindow > 0 ? usage.contextWindow : 0;
  const fraction = window > 0 ? usage.tokens / window : 0;
  const percent = Number.isFinite(usage.percent) ? usage.percent : fraction * 100;
  const exact = `${exactNum(usage.tokens)} of ${window > 0 ? exactNum(window) : "?"} context tokens (${percent.toFixed(2)}%)`;
  return (
    <div className="flex shrink-0 items-center gap-2" title={exact}>
      <Meter fraction={fraction} className="w-20" title={exact} />
      <span className="hidden font-mono text-[11px] tabular-nums text-ink-mid md:inline">
        {compactNum(usage.tokens)} / {window > 0 ? compactNum(window) : "?"}
      </span>
      <span
        className={cn(
          "font-mono text-[11px] tabular-nums",
          percent > 90 ? "text-rose" : percent > 70 ? "text-copper" : "text-ink-dim",
        )}
      >
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}

/**
 * The second context/cost readout, for the advisor. Quiet and neutral (never
 * the signal accent — this is chrome, not liveness): an `adv` tag, a compact
 * context meter, the fill percent, and cost. Hidden until the extension has
 * published real stats.
 */
function AdvisorCluster({ stats }: { stats: AdvisorStatsView }) {
  const window = stats.contextWindow > 0 ? stats.contextWindow : 0;
  const percent = window > 0 ? (stats.contextTokens / window) * 100 : 0;
  // A subscription-billed advisor legitimately accrues $0 — omp's own TUI
  // renders "(sub)". Mirror that instead of a $0.0000 that reads as broken.
  const spend = stats.subscription && stats.cost === 0 ? "sub" : formatCost(stats.cost);
  const exact =
    `advisor${stats.model ? ` · ${stats.model}` : ""}: ` +
    `${exactNum(stats.contextTokens)} of ${window > 0 ? exactNum(window) : "?"} context tokens` +
    ` (${percent.toFixed(2)}%) · ${stats.subscription ? "subscription billing" : formatCost(stats.cost)}`;
  return (
    <div className="hidden shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 lg:flex" title={exact}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">adv</span>
      <Meter fraction={window > 0 ? stats.contextTokens / window : 0} className="w-14" title={exact} />
      <span className="font-mono text-[10px] tabular-nums text-ink-dim" title={exact}>
        {percent.toFixed(1)}%
      </span>
      <span className="font-mono text-[10px] tabular-nums text-ink-faint" title={exact}>
        {spend}
      </span>
    </div>
  );
}

const STEERING_MODES = ["one-at-a-time", "all-at-once"];
// omp's interrupt enum is immediate|wait; "queue" is stored but behaves as
// immediate (omp branches on `!== "wait"`), so never offer it (issue #81).
const INTERRUPT_MODES = ["immediate", "wait"];

// Native-tooltip copy for the queue-mode controls (issue #80). Steering and
// follow-up option text is omp's own settings copy; interrupt text mirrors
// the tool-loop branch (`wait` lets the in-flight tool finish).
const QUEUE_MODE_HINTS: Record<string, string> = {
  "one-at-a-time": "process queued messages one by one, one per turn (recommended)",
  "all-at-once": "process all queued messages at once",
};
const INTERRUPT_MODE_HINTS: Record<string, string> = {
  immediate: "interrupt the in-flight tool as soon as a steering message arrives",
  wait: "let the current tool finish, then inject queued steering",
};
const ROW_HINTS = {
  steering: "steering messages: what you send while the agent is still running",
  "follow-up": "follow-up messages: queued to run after the current turn completes",
  interrupt: "when steering messages may interrupt tool execution",
} as const;

function ModeRow({
  label,
  value,
  known,
  onChange,
  hint,
  optionHints,
}: {
  label: string;
  value: string | null;
  known: string[];
  onChange: (value: string) => void;
  hint?: string;
  optionHints?: Record<string, string>;
}) {
  // Forward-compatible: an unrecognised current value becomes its own segment
  // rather than silently rendering as "nothing selected".
  const values = value && !known.includes(value) ? [...known, value] : known;
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 flex items-baseline justify-between gap-2" title={hint}>
        <Label>{label}</Label>
        <span className="font-mono text-[10px] text-ink-faint">{value ?? "—"}</span>
      </div>
      <Segmented value={value} options={values.map((v) => ({ value: v, label: v, title: optionHints?.[v] }))} onChange={onChange} />
    </div>
  );
}

function ModesPopover({ tabId }: { tabId: string }) {
  const session = useStore((s) => s.rpc[tabId]?.session);
  const setSteeringMode = useStore((s) => s.setSteeringMode);
  const setFollowUpMode = useStore((s) => s.setFollowUpMode);
  const setInterruptMode = useStore((s) => s.setInterruptMode);
  const setAutoRetry = useStore((s) => s.setAutoRetry);
  const abortRetry = useStore((s) => s.abortRetry);
  const [open, setOpen] = useState(false);
  // omp exposes no auto-retry readback in get_state, so the switch tracks what
  // this window has asked for; retry is on by default in omp.
  const [autoRetry, setAutoRetryLocal] = useState(true);
  const anchor = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Portaled + fixed: the wide HUD root is overflow-hidden inside the h-9 title
  // bar, so an in-tree `absolute top-full` panel is clipped to nothing.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    place();
    const onDown = (e: MouseEvent) => {
      // Fail closed: a click we cannot prove is inside the anchor or the
      // portaled panel dismisses, so the popover can never get stuck open.
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <div ref={anchor} className="relative shrink-0">
      <IconButton
        label="queue modes and retry"
        onClick={() => setOpen(!open)}
        className={open ? "bg-hover text-ink" : undefined}
      >
        <IconSliders />
      </IconButton>
      {open && pos && createPortal(
        <div ref={panelRef} className="fixed z-[70]" style={pos}>
        <Panel className="edge-lit animate-rise w-[16rem] p-2.5">
          <ModeRow
            label="steering"
            value={session?.steeringMode ?? null}
            known={STEERING_MODES}
            onChange={(v) => void setSteeringMode(tabId, v)}
            hint={ROW_HINTS.steering}
            optionHints={QUEUE_MODE_HINTS}
          />
          <ModeRow
            label="follow-up"
            value={session?.followUpMode ?? null}
            known={STEERING_MODES}
            onChange={(v) => void setFollowUpMode(tabId, v)}
            hint={ROW_HINTS["follow-up"]}
            optionHints={QUEUE_MODE_HINTS}
          />
          <ModeRow
            label="interrupt"
            value={session?.interruptMode ?? null}
            known={INTERRUPT_MODES}
            onChange={(v) => void setInterruptMode(tabId, v)}
            hint={ROW_HINTS.interrupt}
            optionHints={INTERRUPT_MODE_HINTS}
          />
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-soft pt-2.5">
            <Button
              variant="ghost"
              size="xs"
              tone="rose"
              title="abort an in-flight retry backoff"
              onClick={() => void abortRetry(tabId)}
            >
              abort retry
            </Button>
            {/* Label and switch stay adjacent: Switch renders no visible text,
                so proximity is the only association (issue #79). */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-mid">auto-retry</span>
              <Switch
                on={autoRetry}
                label="auto-retry"
                title="retry transient provider errors automatically"
                onChange={(next) => {
                  setAutoRetryLocal(next);
                  void setAutoRetry(tabId, next);
                }}
              />
            </div>
          </div>
        </Panel>
        </div>,
        document.body,
      )}
    </div>
  );
}

function CompactModes({ tabId }: { tabId: string }) {
  const session = useStore((s) => s.rpc[tabId]?.session);
  const setSteeringMode = useStore((s) => s.setSteeringMode);
  const setFollowUpMode = useStore((s) => s.setFollowUpMode);
  const setInterruptMode = useStore((s) => s.setInterruptMode);
  const setAutoRetry = useStore((s) => s.setAutoRetry);
  const abortRetry = useStore((s) => s.abortRetry);
  const [autoRetry, setAutoRetryLocal] = useState(true);
  return (
    <div className="space-y-3 border-t border-line p-3">
      <ModeRow label="steering" value={session?.steeringMode ?? null} known={STEERING_MODES} onChange={(v) => void setSteeringMode(tabId, v)} hint={ROW_HINTS.steering} optionHints={QUEUE_MODE_HINTS} />
      <ModeRow label="follow-up" value={session?.followUpMode ?? null} known={STEERING_MODES} onChange={(v) => void setFollowUpMode(tabId, v)} hint={ROW_HINTS["follow-up"]} optionHints={QUEUE_MODE_HINTS} />
      <ModeRow label="interrupt" value={session?.interruptMode ?? null} known={INTERRUPT_MODES} onChange={(v) => void setInterruptMode(tabId, v)} hint={ROW_HINTS.interrupt} optionHints={INTERRUPT_MODE_HINTS} />
      <div className="flex items-center justify-between gap-3 border-t border-line-soft pt-3">
        <Button variant="ghost" tone="rose" onClick={() => void abortRetry(tabId)}>abort retry</Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-mid">auto-retry</span>
          <Switch on={autoRetry} label="auto-retry" onChange={(next) => { setAutoRetryLocal(next); void setAutoRetry(tabId, next); }} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the HUD */

export function SessionHud({ tabId }: { tabId: string }) {
  const status = useStore((s) => s.rpc[tabId]?.status) ?? "starting";
  const session = useStore((s) => s.rpc[tabId]?.session);
  const stats = useStore((s) => s.rpc[tabId]?.stats);
  const extensionStatus = useStore((s) => s.rpc[tabId]?.extensionStatus);
  const title = useStore((s) => findRecord(s.state, tabId)?.title);
  const compactSession = useStore((s) => s.compactSession);
  const setAutoCompaction = useStore((s) => s.setAutoCompaction);
  const exportHtml = useStore((s) => s.exportHtml);
  const branchSession = useStore((s) => s.branchSession);
  const newSession = useStore((s) => s.newSession);
  const refreshState = useStore((s) => s.refreshState);
  const refreshStats = useStore((s) => s.refreshStats);
  const refreshAdvisorStats = useStore((s) => s.refreshAdvisorStats);
  const advisor = useStore((s) => findRecord(s.state, tabId)?.advisor);
  const advisorStats = useStore((s) => s.rpc[tabId]?.advisorStats);
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd);
  const openMcpManager = useStore((s) => s.openMcpManager);
  const compact = useCompactShell();
  const surface = useStore((s) => s.compactSurface);
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);

  const usage = session?.contextUsage ?? stats?.contextUsage ?? null;
  const face = STATUS[status] ?? STATUS.starting;
  const notices = Object.entries(extensionStatus ?? {}).filter(([, text]) => text.trim() !== "");


  const refresh = () => {
    void refreshState(tabId);
    void refreshStats(tabId);
    if (status !== "running" && session?.isStreaming !== true) void refreshAdvisorStats(tabId);
  };

  if (compact) {
    return (
      <>
        <header className="ambient flex min-h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-sunken px-3">
          {session?.isCompacting ? <Chip tone="copper"><Dot tone="copper" pulse />compacting</Chip> : <span className="flex items-center gap-1.5 text-[11px] text-ink-dim"><Dot tone={face.tone} pulse={face.pulse} />{status}</span>}
          {plan?.enabled && <Chip tone="iris">plan</Chip>}
          <span className="min-w-0 flex-1" />
          {usage && <ContextCluster usage={usage} />}
          <ConsoleToggle tabId={tabId} className="min-h-11 min-w-11" />
          <Button variant="ghost" onClick={() => showCompactSurface("session-actions")}>session actions</Button>
        </header>
        <Sheet open={surface === "session-actions"} placement="bottom" label="session actions" onClose={closeCompactSurface}>
          <div className="space-y-3 p-3">
            <div className="flex items-center gap-2"><Label className="shrink-0">session</Label><TitleField tabId={tabId} title={title ?? "untitled"} /></div>
            {usage && <div className="flex items-center justify-between gap-3"><Label>main usage</Label><ContextCluster usage={usage} /></div>}
            {stats && <p className="font-mono text-xs text-ink-dim">{formatCost(stats.cost)} · {exactNum(stats.tokens.total)} tokens · {stats.premiumRequests} premium requests</p>}
            {advisorStats?.available === true && (advisor === true || advisorStats.configured === true) && <p className="font-mono text-xs text-ink-dim">advisor · {exactNum(advisorStats.contextTokens)} tokens · {advisorStats.subscription && advisorStats.cost === 0 ? "subscription" : formatCost(advisorStats.cost)}</p>}
            {notices.map(([key, text]) => <Chip key={key} mono title={key}>{text}</Chip>)}
            <div className="grid grid-cols-2 gap-2">
              <PlanToggle tabId={tabId} layout="sheet" />
              <Button tone="copper" disabled={session?.isCompacting} onClick={() => void compactSession(tabId)}>compact</Button>
              <div className="flex min-h-11 items-center justify-between rounded-md border border-line px-3"><span className="text-xs">auto-compact</span><Switch on={session?.autoCompactionEnabled ?? false} label="auto-compact" onChange={(next) => void setAutoCompaction(tabId, next)} /></div>
              <Button onClick={() => void exportHtml(tabId)}>export</Button>
              {projectCwd !== undefined && <Button onClick={() => openMcpManager(tabId, projectCwd)}>MCP</Button>}
              <Button title="branch this session into a new tab" onClick={() => void branchSession(tabId)}>branch</Button>
              <Button disabled={projectCwd === undefined} onClick={() => { if (projectCwd !== undefined) void newSession(projectCwd); }}>new</Button>
              <Button onClick={refresh}>refresh</Button>
            </div>
          </div>
          <CompactModes tabId={tabId} />
        </Sheet>
      </>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden px-2 [app-region:no-drag]">
      {session?.isCompacting ? (
        <Chip tone="copper" className="shrink-0">
          <Dot tone="copper" pulse />
          compacting
        </Chip>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-dim" title={`rpc status: ${status}`}>
          <Dot tone={face.tone} pulse={face.pulse} />
          {status}
        </span>
      )}

      {plan?.enabled && (
        <Chip tone="iris" className="shrink-0" title={plan.planFilePath ?? "drafting a plan"}>
          plan
        </Chip>
      )}

      <TitleField tabId={tabId} title={title ?? "untitled"} />

      <span className="min-w-0 flex-1" />

      {usage && <ContextCluster usage={usage} />}

      {/* `available:true` is emitted for both on and off sessions (off reports
          configured:false), so the record flag alone was the gate — and it can be
          stale after an advisor-toggle relaunch. The extension's `configured` is
          omp's own runtime truth for "advisor is enabled", so a genuinely-running
          advisor shows even if the record lags; an off session stays hidden. */}
      {advisorStats?.available === true && (advisor === true || advisorStats.configured === true) && (
        <AdvisorCluster stats={advisorStats} />
      )}

      {stats && (
        <div
          className="hidden shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-faint transition-colors hover:bg-raised hover:text-ink-mid lg:flex"
          title={`${formatCost(stats.cost)} · ${exactNum(stats.tokens.total)} tokens · ${stats.premiumRequests} premium requests`}
        >
          <span>{formatCost(stats.cost)}</span>
          <span className="text-line-strong">·</span>
          <span>{compactNum(stats.tokens.total)} tok</span>
        </div>
      )}

      {notices.length > 0 && (
        <div className="hidden min-w-0 shrink items-center gap-1 xl:flex">
          {notices.slice(0, 2).map(([key, text]) => (
            <Chip key={key} mono title={`${key}: ${text}`}>
              <span className="block max-w-[9rem] truncate">{text}</span>
            </Chip>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-l border-line-soft pl-2.5">
        <PlanToggle tabId={tabId} />
        <span className="mx-0.5 h-4 w-px bg-line-soft" />
        <Button
          size="xs"
          variant="ghost"
          tone="copper"
          title="compact the conversation now"
          disabled={session?.isCompacting}
          onClick={() => void compactSession(tabId)}
        >
          <IconCompact />
          <span className="hidden lg:inline">compact</span>
        </Button>
        <Switch
          on={session?.autoCompactionEnabled ?? false}
          label="auto-compact"
          title="auto-compact when the context window fills"
          onChange={(next) => void setAutoCompaction(tabId, next)}
        />
        <span className="mx-0.5 h-4 w-px bg-line-soft" />
        <ConsoleToggle tabId={tabId} />
        <IconButton label="export transcript as html" onClick={() => void exportHtml(tabId)}>
          <IconExport />
        </IconButton>
        {projectCwd !== undefined && (
          <IconButton
            label="manage MCP servers"
            onClick={() => openMcpManager(tabId, projectCwd)}
          >
            <IconMcp />
          </IconButton>
        )}
        <IconButton label="branch this session into a new tab" onClick={() => void branchSession(tabId)}>
          <IconBranch />
        </IconButton>
        {/* Same command as the composer's bare /new and mod+shift+n: spawn a
            new live session tab in this project, not an in-tab reset (#82). */}
        <IconButton
          label="new session in current project"
          disabled={projectCwd === undefined}
          onClick={() => {
            if (projectCwd !== undefined) void newSession(projectCwd);
          }}
        >
          <IconNew />
        </IconButton>
        <IconButton
          label="refresh state and stats"
          onClick={() => {
            void refreshState(tabId);
            void refreshStats(tabId);
            // The advisor refresh rides a slash prompt, which a live turn could
            // misfile as a steer — the extension auto-publishes at the next
            // turn boundary, so never force it while running.
            if (status !== "running" && session?.isStreaming !== true) {
              void refreshAdvisorStats(tabId);
            }
          }}
        >
          <IconRefresh />
        </IconButton>
        <ModesPopover tabId={tabId} />
      </div>
    </div>
  );
}
