import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import { cn } from "../lib/cn";
import type { ContextUsage } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { Button, Chip, Dot, IconButton, Label, Meter, Panel, Switch, type Tone } from "./ui";

/**
 * The instrument's status bar: one line that answers "is it alive, what is it
 * called, how full is the context, and what can I do to it right now".
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

function IconPlan() {
  return (
    <Svg>
      <path {...S} d="M4.5 2.5h5l3 3v8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
      <path {...S} d="M9.5 2.5v3h3" />
      <path {...S} d="M6.5 9.5l1.25 1.25 2.25-2.5" />
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
const INTERRUPT_MODES = ["immediate", "queue"];

function ModeRow({
  label,
  value,
  known,
  onChange,
}: {
  label: string;
  value: string | null;
  known: string[];
  onChange: (value: string) => void;
}) {
  // Forward-compatible: an unrecognised current value becomes its own segment
  // rather than silently rendering as "nothing selected".
  const values = value && !known.includes(value) ? [...known, value] : known;
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        <span className="font-mono text-[10px] text-ink-faint">{value ?? "—"}</span>
      </div>
      <Segmented value={value} options={values.map((v) => ({ value: v, label: v }))} onChange={onChange} />
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Fail closed: a click we cannot prove is inside the anchor dismisses,
      // so the popover can never get stuck open.
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
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
      {open && (
        <Panel className="edge-lit animate-rise absolute right-0 top-full z-20 mt-1.5 w-[16rem] p-2.5">
          <ModeRow
            label="steering"
            value={session?.steeringMode ?? null}
            known={STEERING_MODES}
            onChange={(v) => void setSteeringMode(tabId, v)}
          />
          <ModeRow
            label="follow-up"
            value={session?.followUpMode ?? null}
            known={STEERING_MODES}
            onChange={(v) => void setFollowUpMode(tabId, v)}
          />
          <ModeRow
            label="interrupt"
            value={session?.interruptMode ?? null}
            known={INTERRUPT_MODES}
            onChange={(v) => void setInterruptMode(tabId, v)}
          />
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-soft pt-2.5">
            <span className="text-[11px] text-ink-mid">auto-retry</span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                tone="rose"
                title="abort an in-flight retry backoff"
                onClick={() => void abortRetry(tabId)}
              >
                abort retry
              </Button>
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
      )}
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
  const newRpcSession = useStore((s) => s.newRpcSession);
  const refreshState = useStore((s) => s.refreshState);
  const refreshStats = useStore((s) => s.refreshStats);
  const refreshAdvisorStats = useStore((s) => s.refreshAdvisorStats);
  const advisor = useStore((s) => findRecord(s.state, tabId)?.advisor);
  const advisorStats = useStore((s) => s.rpc[tabId]?.advisorStats);
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const setPlanMode = useStore((s) => s.setPlanMode);

  const usage = session?.contextUsage ?? stats?.contextUsage ?? null;
  const face = STATUS[status] ?? STATUS.starting;
  const notices = Object.entries(extensionStatus ?? {}).filter(([, text]) => text.trim() !== "");

  return (
    <header className="flex h-9 shrink-0 items-center gap-2.5 overflow-hidden border-b border-line bg-sunken px-3">
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
        <Button
          size="xs"
          variant={plan?.enabled ? "solid" : "ghost"}
          tone="iris"
          // The extension reaches omp's plan API through unsupported surface,
          // so it reports `unavailable` rather than letting the toggle lie.
          disabled={plan?.unavailable !== undefined}
          title={
            plan?.unavailable
              ? `plan mode unavailable: ${plan.unavailable}`
              : plan?.enabled
                ? "leave plan mode (restores write access)"
                : "plan first: the agent explores read-only and drafts a plan for review"
          }
          onClick={() => void setPlanMode(tabId, !(plan?.enabled ?? false))}
        >
          <IconPlan />
          <span className="hidden lg:inline">plan</span>
        </Button>
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
        <IconButton label="export transcript as html" onClick={() => void exportHtml(tabId)}>
          <IconExport />
        </IconButton>
        <IconButton label="branch this session" onClick={() => void branchSession(tabId)}>
          <IconBranch />
        </IconButton>
        <IconButton label="new session in this tab" onClick={() => void newRpcSession(tabId)}>
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
    </header>
  );
}
