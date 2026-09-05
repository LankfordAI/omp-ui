import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import { compactionThresholdTokens } from "@omp-ui/core/compaction-threshold";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/duration";
import { compactNum, exactNum, formatCost } from "../lib/format";
import { useCompactShell } from "../lib/responsive";
import { useT } from "../lib/i18n";
import type { ContextUsage } from "../lib/rpc-types";
import { findRecord, sessionCwd, useStore } from "../store";
import { useDismissal } from "../lib/use-dismissal";
import { ConsoleToggle } from "./ConsoleDrawer";
import { BuildPlanControl } from "./BuildPlanControl";
import { WorktreeChip } from "./WorktreeChip";
import { Button, Chip, CopyButton, Dot, ICON_STROKE, IconButton, IconRefresh, IconTune, Label, Meter, Panel, Sheet, Switch, type Tone } from "./ui";

/**
 * The instrument's status bar: one line that answers "is it alive, what is it
 * called, how full is the context, and what can I do to it right now".
 *
 * On desktop the HUD renders inside App's merged title bar (issue #60); the
 * compact branch below is unchanged and still renders in-tab inside RpcTab.
 *
 * The two micro-controls below live here rather than in `ui.tsx` (which
 * Main owns) because only the RPC chrome consumes them.
 */
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
      <path d="M8 1.5V6M5.5 3.5L8 6l2.5-2.5" {...ICON_STROKE} />
      <path d="M8 14.5V10M5.5 12.5L8 10l2.5 2.5" {...ICON_STROKE} />
      <path d="M2.5 8h11" {...ICON_STROKE} />
    </Svg>
  );
}

function IconExport() {
  return (
    <Svg>
      <path d="M8 10.5V2M5 5l3-3 3 3" {...ICON_STROKE} />
      <path d="M2.5 10v3.5h11V10" {...ICON_STROKE} />
    </Svg>
  );
}

function IconBranch() {
  return (
    <Svg>
      <circle cx="4" cy="3.8" r="1.7" {...ICON_STROKE} />
      <circle cx="4" cy="12.2" r="1.7" {...ICON_STROKE} />
      <circle cx="11.8" cy="4.6" r="1.7" {...ICON_STROKE} />
      <path d="M4 5.5v5.1M10.1 4.6H8.4A4.4 4.4 0 004 9v1.4" {...ICON_STROKE} />
    </Svg>
  );
}

function IconNew() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="6" {...ICON_STROKE} />
      <path d="M8 5.2v5.6M5.2 8h5.6" {...ICON_STROKE} />
    </Svg>
  );
}

function IconMcp() {
  return (
    <Svg>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" {...ICON_STROKE} />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" {...ICON_STROKE} />
      <path d="M5 4.75h.01M5 11.25h.01" {...ICON_STROKE} />
    </Svg>
  );
}

function IconKebab() {
  return (
    <Svg>
      <circle cx="8" cy="3.2" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.8" r="1.2" fill="currentColor" stroke="none" />
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

/** Observation-only claim for the stall chip (issue #228, #179). */

/**
 * The live stream-stall chip (issue #228), one component for both HUD
 * faces. The dot has no pulse: ADR-0004 reserves `breathe` for "work is
 * happening right now", and a stalled stream is the negation of that.
 */
function StreamStallChip({
  stallMs,
  short,
  className,
}: {
  stallMs: number;
  short?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <Chip tone="copper" mono title={t("hud.stall.explanation")} className={cn("shrink-0", className)}>
      <Dot tone="copper" />
      {short
        ? t("hud.stall.short", { duration: formatDuration(stallMs) })
        : t("hud.stall.long", { duration: formatDuration(stallMs) })}
    </Chip>
  );
}

/** The three-way liveness readout: compacting > stalled > plain status. */
function LivenessBadge({
  compacting,
  stallMs,
  face,
  label,
  short = false,
  className,
  title,
}: {
  compacting: boolean;
  stallMs: number | undefined;
  face: { tone: Tone; pulse: boolean };
  label: string;
  short?: boolean;
  className?: string;
  title?: string;
}) {
  const t = useT();
  if (compacting) {
    return (
      <Chip tone="copper" className={className}>
        <Dot tone="copper" pulse />
        {t("hud.status.compacting")}
      </Chip>
    );
  }
  if (stallMs !== undefined) {
    return <StreamStallChip stallMs={stallMs} short={short} className={className} />;
  }
  return (
    <span className={cn("flex items-center gap-1.5 text-[11px] text-ink-dim", className)} title={title}>
      <Dot tone={face.tone} pulse={face.pulse} />
      {label}
    </span>
  );
}

/**
 * Click-to-rename title. Enter commits; Escape and blur both abandon.
 * Both faces are no-drag: in the wide HUD they sit inside the title bar's
 * drag region, which would otherwise swallow the click (#108). Harmless
 * no-op in the compact sheet, which is not a drag region.
 */
function TitleField({ tabId, title }: { tabId: string; title: string }) {
  const t = useT();
  const renameSessionTo = useStore((s) => s.renameSessionTo);
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <button
        type="button"
        title={t("hud.session.renameTitle", { title })}
        onClick={() => setDraft(title)}
        className="min-w-0 truncate rounded px-1 py-0.5 text-left font-display text-[13px] text-ink transition-colors hover:bg-hover [app-region:no-drag]"
      >
        {title}
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      aria-label={t("hud.session.nameLabel")}
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
      className="min-w-0 flex-1 rounded border border-line-strong bg-void px-1.5 py-0.5 font-display text-[13px] text-ink outline-none focus:border-signal-dim [app-region:no-drag]"
    />
  );
}

function ContextCluster({
  usage,
  markerTokens,
}: {
  usage: ContextUsage;
  /** Token count where omp auto-compacts; null/undefined = no notch. */
  markerTokens?: number | null;
}) {
  const t = useT();
  const window = usage.contextWindow > 0 ? usage.contextWindow : 0;
  const fraction = window > 0 ? usage.tokens / window : 0;
  const percent = Number.isFinite(usage.percent) ? usage.percent : fraction * 100;
  const threshold =
    typeof markerTokens === "number" && window > 0
      ? { tokens: markerTokens, at: Math.min(1, Math.max(0, markerTokens / window)) }
      : null;
  const thresholdLine = threshold
    ? t("hud.context.autoCompactThreshold", {
        threshold: exactNum(threshold.tokens),
        window: exactNum(window),
        percent: ((threshold.tokens / window) * 100).toFixed(1),
      })
    : null;
  const exact = t("hud.context.usage", {
    tokens: exactNum(usage.tokens),
    window: window > 0 ? exactNum(window) : "?",
    percent: percent.toFixed(2),
    threshold: thresholdLine ? `\n${thresholdLine}` : "",
  });
  return (
    <div className="flex shrink-0 items-center gap-2" title={exact}>
      <Meter fraction={fraction} marker={threshold?.at ?? null} className="titlebar-context-meter w-20" title={exact} />
      <span className="titlebar-context-tokens hidden font-mono text-[11px] tabular-nums text-ink-mid md:inline">
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
  const t = useT();
  const window = stats.contextWindow > 0 ? stats.contextWindow : 0;
  const percent = window > 0 ? (stats.contextTokens / window) * 100 : 0;
  // A subscription-billed root advisor legitimately accrues $0. Descendant
  // usage can still make the session-tree total nonzero, which stays numeric.
  const spend = stats.subscription && stats.cost === 0 ? t("hud.advisor.subscriptionShort") : formatCost(stats.cost);
  const billing =
    stats.subscription && stats.cost === 0
      ? t("hud.advisor.subscriptionBilling")
      : t("hud.advisor.sessionSpend", { cost: formatCost(stats.cost) });
  const exact = t("hud.advisor.contextUsage", {
    model: stats.model ? ` · ${stats.model}` : "",
    tokens: exactNum(stats.contextTokens),
    window: window > 0 ? exactNum(window) : "?",
    percent: percent.toFixed(2),
    billing,
    totalTokens: exactNum(stats.totalTokens),
  });
  return (
    <div className="titlebar-advisor hidden shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 lg:flex [app-region:no-drag]" title={exact}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{t("hud.advisor.shortLabel")}</span>
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
function useModeCopy() {
  const t = useT();
  return {
    labels: {
      steering: t("hud.modes.steering"),
      followUp: t("hud.modes.followUp"),
      interrupt: t("hud.modes.interrupt"),
    },
    queueHints: {
      "one-at-a-time": t("hud.modes.oneAtATimeHint"),
      "all-at-once": t("hud.modes.allAtOnceHint"),
    },
    interruptHints: {
      immediate: t("hud.modes.immediateHint"),
      wait: t("hud.modes.waitHint"),
    },
    rowHints: {
      steering: t("hud.modes.steeringHint"),
      followUp: t("hud.modes.followUpHint"),
      interrupt: t("hud.modes.interruptHint"),
    },
  };
}

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
  const t = useT();
  const modeCopy = useModeCopy();
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
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Fail closed: a click we cannot prove is inside the anchor or the
  // portaled panel dismisses, so the popover can never get stuck open.
  useDismissal({
    open,
    refs: [anchor, panelRef],
    onClose: () => setOpen(false),
    onEscape: () => setOpen(false),
  });

  return (
    <div ref={anchor} className="relative shrink-0">
      <IconButton
        label={t("hud.modes.controlLabel")}
        onClick={() => setOpen(!open)}
        className={open ? "bg-hover text-ink" : undefined}
      >
        <IconTune />
      </IconButton>
      {open && pos && createPortal(
        <div ref={panelRef} className="fixed z-[70]" style={pos}>
        <Panel className="edge-lit animate-rise w-[16rem] p-2.5">
          <ModeRow
            label={modeCopy.labels.steering}
            value={session?.steeringMode ?? null}
            known={STEERING_MODES}
            onChange={(v) => void setSteeringMode(tabId, v)}
            hint={modeCopy.rowHints.steering}
            optionHints={modeCopy.queueHints}
          />
          <ModeRow
            label={modeCopy.labels.followUp}
            value={session?.followUpMode ?? null}
            known={STEERING_MODES}
            onChange={(v) => void setFollowUpMode(tabId, v)}
            hint={modeCopy.rowHints.followUp}
            optionHints={modeCopy.queueHints}
          />
          <ModeRow
            label={modeCopy.labels.interrupt}
            value={session?.interruptMode ?? null}
            known={INTERRUPT_MODES}
            onChange={(v) => void setInterruptMode(tabId, v)}
            hint={modeCopy.rowHints.interrupt}
            optionHints={modeCopy.interruptHints}
          />
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-soft pt-2.5">
            <Button
              variant="ghost"
              size="xs"
              tone="rose"
              title={t("hud.retry.abortTitle")}
              onClick={() => void abortRetry(tabId)}
            >
              {t("hud.retry.abort")}
            </Button>
            {/* Label and switch stay adjacent: Switch renders no visible text,
                so proximity is the only association (issue #79). */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-mid">{t("hud.retry.autoRetry")}</span>
              <Switch
                on={autoRetry}
                label={t("hud.retry.autoRetry")}
                title={t("hud.retry.autoRetryTitle")}
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
  const t = useT();
  const modeCopy = useModeCopy();
  const session = useStore((s) => s.rpc[tabId]?.session);
  const setSteeringMode = useStore((s) => s.setSteeringMode);
  const setFollowUpMode = useStore((s) => s.setFollowUpMode);
  const setInterruptMode = useStore((s) => s.setInterruptMode);
  const setAutoRetry = useStore((s) => s.setAutoRetry);
  const abortRetry = useStore((s) => s.abortRetry);
  const [autoRetry, setAutoRetryLocal] = useState(true);
  return (
    <div className="space-y-3 border-t border-line p-3">
      <ModeRow label={modeCopy.labels.steering} value={session?.steeringMode ?? null} known={STEERING_MODES} onChange={(v) => void setSteeringMode(tabId, v)} hint={modeCopy.rowHints.steering} optionHints={modeCopy.queueHints} />
      <ModeRow label={modeCopy.labels.followUp} value={session?.followUpMode ?? null} known={STEERING_MODES} onChange={(v) => void setFollowUpMode(tabId, v)} hint={modeCopy.rowHints.followUp} optionHints={modeCopy.queueHints} />
      <ModeRow label={modeCopy.labels.interrupt} value={session?.interruptMode ?? null} known={INTERRUPT_MODES} onChange={(v) => void setInterruptMode(tabId, v)} hint={modeCopy.rowHints.interrupt} optionHints={modeCopy.interruptHints} />
      <div className="flex items-center justify-between gap-3 border-t border-line-soft pt-3">
        <Button variant="ghost" tone="rose" onClick={() => void abortRetry(tabId)}>{t("hud.retry.abort")}</Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-mid">{t("hud.retry.autoRetry")}</span>
          <Switch on={autoRetry} label={t("hud.retry.autoRetry")} onChange={(next) => { setAutoRetryLocal(next); void setAutoRetry(tabId, next); }} />
        </div>
      </div>
    </div>
  );
}


/* ---------------------------------------------------------------- the HUD */

export function SessionHud({ tabId }: { tabId: string }) {
  const t = useT();
  const status = useStore((s) => s.rpc[tabId]?.status) ?? "starting";
  // Hibernation overrides the (stale) rpc status: the process is stopped on
  // purpose, not live (issue #246). Neutral, no pulse — the mint signal
  // accent is reserved for liveness (ADR-0004), matching the sidebar's
  // dormant style.
  const hibernated = useStore((s) => s.hibernated[tabId] === true);
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
  const mcpFailureCount = useStore((s) => s.rpc[tabId]?.mcpStatus?.failedServers.length ?? 0);
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const defaultAgentMode = useStore((s) => s.state?.defaultAgentMode ?? "plan");
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd);
  const worktree = useStore((s) => findRecord(s.state, tabId)?.worktree);
  // The viewer resolves and writes where omp does: this session's own working
  // tree, which for a worktree session is its checkout (#325).
  const scopeCwd = useStore((s) => sessionCwd(findRecord(s.state, tabId)));
  const openCapabilitiesViewer = useStore((s) => s.openCapabilitiesViewer);
  const compact = useCompactShell();
  const surface = useStore((s) => s.compactSurface);
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const streamStallMs = useStore((s) => s.rpc[tabId]?.streamStallMs);
  const ensureCompactionSettings = useStore((s) => s.ensureCompactionSettings);
  const compactionSettings = useStore((s) =>
    projectCwd !== undefined ? s.compactionSettings[projectCwd] : undefined,
  );

  // Fetch while the entry is absent: on first mount, and again whenever a
  // compaction.* write clears the cache, so the notch moves without a remount.
  // A failed read lands null (not undefined), so no retry loop.
  const needsCompaction = projectCwd !== undefined && compactionSettings === undefined;
  useEffect(() => {
    if (needsCompaction) void ensureCompactionSettings(projectCwd);
  }, [needsCompaction, projectCwd, ensureCompactionSettings]);

  const usage = session?.contextUsage ?? stats?.contextUsage ?? null;
  // The notch renders only when omp will actually auto-compact this session AND
  // the project's effective threshold settings have loaded (absent = loading,
  // null = read failed — both mean "no notch", never a defaulted one).
  const markerTokens =
    usage !== null &&
    session?.autoCompactionEnabled === true &&
    compactionSettings !== null &&
    compactionSettings !== undefined
      ? compactionThresholdTokens(usage.contextWindow, compactionSettings)
      : null;
  const face = hibernated
    ? { tone: "neutral" as const, pulse: false }
    : STATUS[status] ?? STATUS.starting;
  const label = hibernated
    ? t("hud.status.hibernated")
    : status === "starting"
      ? t("hud.status.starting")
      : status === "ready"
        ? t("hud.status.ready")
        : status === "running"
          ? t("hud.status.running")
          : status === "error"
            ? t("hud.status.error")
            : status;
  const notices = Object.entries(extensionStatus ?? {}).filter(([, text]) => text.trim() !== "");
  const activeAgentMode = plan == null ? null : plan.enabled ? "plan" : "build";
  const exceptionalAgentMode =
    activeAgentMode !== null && activeAgentMode !== defaultAgentMode ? activeAgentMode : null;
  // `available:true` is emitted for both on and off sessions (off reports
  // configured:false), so the record flag alone was the gate — and it can be
  // stale after an advisor-toggle relaunch. The extension's `configured` is
  // omp's own runtime truth for "advisor is enabled", so a genuinely-running
  // advisor shows even if the record lags; an off session stays hidden.
  const showAdvisor =
    advisorStats?.available === true && (advisor === true || advisorStats.configured === true);
  // The agent-mode chip renders in both faces; the wide one carves itself out
  // of the title bar's drag region, the compact sheet does not.
  const agentModeChip = exceptionalAgentMode !== null && (
    <Chip
      tone="iris"
      className={compact ? undefined : "shrink-0 [app-region:no-drag]"}
      title={
        exceptionalAgentMode === "build"
          ? t("hud.mode.buildTitle")
          : t("hud.mode.planTitle", {
              plan: plan?.planFilePath ?? t("hud.mode.noPlanDrafted"),
            })
      }
    >
      {exceptionalAgentMode}
    </Chip>
  );


  const refresh = () => {
    void refreshState(tabId);
    void refreshStats(tabId);
    if (status !== "running" && session?.isStreaming !== true) void refreshAdvisorStats(tabId);
  };

  if (compact) {
    const sheetAction = "min-h-11 justify-start gap-2 px-3 text-xs";
    return (
      <>
        <header className="ambient flex min-h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-sunken pl-3 pr-1">
          <LivenessBadge compacting={session?.isCompacting === true} stallMs={streamStallMs} face={face} label={label} short />
          {agentModeChip}
          <span className="min-w-0 flex-1" />
          {usage && <ContextCluster usage={usage} markerTokens={markerTokens} />}
          <ConsoleToggle tabId={tabId} className="size-11" />
          <IconButton label={t("hud.actions.sessionActions")} onClick={() => showCompactSurface("session-actions")} className="size-11">
            <IconKebab />
            <span className="sr-only">{t("hud.actions.sessionActions")}</span>
          </IconButton>
        </header>
        <Sheet open={surface === "session-actions"} placement="bottom" label={t("hud.actions.sessionActions")} onClose={closeCompactSurface}>
          <div className="space-y-4 p-4">
            <TitleField tabId={tabId} title={title ?? t("hud.session.untitled")} />
            {(usage || stats || advisorStats?.available === true || notices.length > 0 || worktree) && (
              <div className="space-y-2 rounded-lg border border-line bg-raised/60 p-3">
                {worktree && <div className="space-y-1"><div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.worktree")}</Label><span className="flex items-center gap-1"><Chip mono title={worktree.path}>⎇ {worktree.branch}</Chip><CopyButton text={worktree.branch} label={t("hud.actions.copy")} doneLabel={t("hud.actions.copied")} /></span></div><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-mono text-[10px] text-ink-faint" title={worktree.path}>{worktree.path}</span><CopyButton text={worktree.path} label={t("hud.actions.copy")} doneLabel={t("hud.actions.copied")} /></div></div>}
                {usage && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.context")}</Label><ContextCluster usage={usage} markerTokens={markerTokens} /></div>}
                {stats && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.spend")}</Label><span className="font-mono text-xs tabular-nums text-ink-mid">{t("hud.stats.compact", { cost: formatCost(stats.cost), tokens: compactNum(stats.tokens.total), premium: stats.premiumRequests })}</span></div>}
                {showAdvisor && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.advisorTotal")}</Label><span className="font-mono text-xs tabular-nums text-ink-mid" title={t("hud.advisor.totalUsage", { tokens: exactNum(advisorStats.totalTokens), cost: formatCost(advisorStats.cost) })}>{t("hud.advisor.compactTotal", { tokens: compactNum(advisorStats.totalTokens), spend: advisorStats.subscription && advisorStats.cost === 0 ? t("hud.advisor.subscriptionShort") : formatCost(advisorStats.cost) })}</span></div>}
                {notices.length > 0 && <div className="flex flex-wrap gap-1.5">{notices.map(([key, text]) => <Chip key={key} mono title={key}>{text}</Chip>)}</div>}
              </div>
            )}
            <div>
              <Label>{t("hud.actions.heading")}</Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <BuildPlanControl tabId={tabId} layout="sheet" className={sheetAction} />
                <Button tone="copper" disabled={session?.isCompacting} onClick={() => void compactSession(tabId)} className={sheetAction}><IconCompact />{t("hud.actions.compact")}</Button>
                <Button onClick={() => void exportHtml(tabId)} className={sheetAction}><IconExport />{t("hud.actions.export")}</Button>
                {scopeCwd !== undefined && <Button onClick={() => openCapabilitiesViewer(scopeCwd, tabId, "mcp")} className={sheetAction}><IconMcp />{t("hud.actions.capabilities")}{mcpFailureCount > 0 && <Chip tone="rose" className="ml-auto">{t("hud.actions.failureCount", { count: mcpFailureCount })}</Chip>}</Button>}
                <Button title={t("hud.actions.branchTitle")} onClick={() => void branchSession(tabId)} className={sheetAction}><IconBranch />{t("hud.actions.branch")}</Button>
                <Button disabled={projectCwd === undefined} onClick={() => { if (projectCwd !== undefined) void newSession(projectCwd); }} className={sheetAction}><IconNew />{t("hud.actions.new")}</Button>
                <Button onClick={refresh} className={sheetAction}><IconRefresh />{t("hud.actions.refresh")}</Button>
                <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-line px-3"><span className="text-xs">{t("hud.actions.autoCompact")}</span><Switch on={session?.autoCompactionEnabled ?? false} label={t("hud.actions.autoCompact")} onChange={(next) => void setAutoCompaction(tabId, next)} /></div>
              </div>
            </div>
          </div>
          <CompactModes tabId={tabId} />
        </Sheet>
      </>
    );
  }
  // The HUD is the widest stretch of the merged title bar (issue #60), so it
  // owns the window's drag affordance: the root is the drag region and every
  // control below carves itself back out with [app-region:no-drag] (#108). A
  // blanket no-drag here left the strip ungrabbable except for two 4px gaps.
  // Draggable regions swallow every pointer event, so a new control added to
  // this row MUST sit inside a no-drag box — and never wrap `flex-1`.
  return (
    <div className="titlebar-hud flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden px-2 [app-region:drag]">
      <LivenessBadge
        compacting={session?.isCompacting === true}
        stallMs={streamStallMs}
        face={face}
        label={label}
        className="shrink-0 [app-region:no-drag]"
        title={t("hud.status.rpcStatus", { status: label })}
      />

      {agentModeChip}
      {worktree && projectCwd !== undefined && (
        <WorktreeChip
          worktree={worktree}
          tabId={tabId}
          projectCwd={projectCwd}
          className="[app-region:no-drag]"
        />
      )}


      <TitleField tabId={tabId} title={title ?? t("hud.session.untitled")} />

      <span className="min-w-0 flex-1" />

      {/* Main usage and main spend read as one group (issue #107). The wrapper keeps
          `usage` and `stats` independent conditionals: either can be null without
          dropping the other. */}
      {(usage || stats) && (
        <div className="flex shrink-0 items-center gap-2 [app-region:no-drag]">
          {usage && <ContextCluster usage={usage} markerTokens={markerTokens} />}
          {stats && (
            <div
              className="titlebar-main-stats hidden shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-ink-faint transition-colors hover:text-ink-mid lg:flex"
              title={t("hud.stats.details", { cost: formatCost(stats.cost), tokens: exactNum(stats.tokens.total), premium: stats.premiumRequests })}
            >
              <span>{formatCost(stats.cost)}</span>
              <span className="text-line-strong">·</span>
              <span>{t("hud.stats.tokenShort", { tokens: compactNum(stats.tokens.total) })}</span>
            </div>
          )}
        </div>
      )}

      {showAdvisor && (
        <AdvisorCluster stats={advisorStats} />
      )}

      {notices.length > 0 && (
        <div className="titlebar-notices hidden min-w-0 shrink items-center gap-1 xl:flex [app-region:no-drag]">
          {notices.slice(0, 2).map(([key, text]) => (
            <Chip key={key} mono title={`${key}: ${text}`}>
              <span className="block max-w-[9rem] truncate">{text}</span>
            </Chip>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-l border-line-soft pl-2.5 [app-region:no-drag]">
        <Button
          size="xs"
          variant="ghost"
          tone="copper"
          title={t("hud.actions.compactTitle")}
          disabled={session?.isCompacting}
          onClick={() => void compactSession(tabId)}
        >
          <IconCompact />
          <span className="titlebar-compact-label hidden lg:inline">{t("hud.actions.compact")}</span>
        </Button>
        <Switch
          on={session?.autoCompactionEnabled ?? false}
          label={t("hud.actions.autoCompact")}
          title={t("hud.actions.autoCompactTitle")}
          onChange={(next) => void setAutoCompaction(tabId, next)}
        />
        <span className="mx-0.5 h-4 w-px bg-line-soft" />
        <ConsoleToggle tabId={tabId} />
        <IconButton label={t("hud.actions.exportTitle")} onClick={() => void exportHtml(tabId)}>
          <IconExport />
        </IconButton>
        {scopeCwd !== undefined && (
          <span className="relative shrink-0">
            <IconButton
              label={mcpFailureCount > 0 ? t("hud.actions.capabilitiesFailed", { count: mcpFailureCount }) : t("hud.actions.capabilities")}
              onClick={() => openCapabilitiesViewer(scopeCwd, tabId, "mcp")}
            >
              <IconMcp />
            </IconButton>
            {mcpFailureCount > 0 && (
              <span className="pointer-events-none absolute -right-1.5 -top-1 min-w-3 rounded-full bg-rose-wash px-0.5 text-center font-mono text-[9px] leading-3 text-rose">
                {mcpFailureCount > 99 ? "99+" : mcpFailureCount}
              </span>
            )}
          </span>
        )}
        <IconButton label={t("hud.actions.branchTitle")} onClick={() => void branchSession(tabId)}>
          <IconBranch />
        </IconButton>
        {/* Same command as the composer's bare /new and mod+shift+n: spawn a
            new live session tab in this project, not an in-tab reset (#82). */}
        <IconButton
          label={t("hud.actions.newTitle")}
          disabled={projectCwd === undefined}
          onClick={() => {
            if (projectCwd !== undefined) void newSession(projectCwd);
          }}
        >
          <IconNew />
        </IconButton>
        <IconButton
          label={t("hud.actions.refreshTitle")}
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
