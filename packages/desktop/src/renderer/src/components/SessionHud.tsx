import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import { compactionThresholdTokens } from "@omp-ui/core/compaction-threshold";
import type { VibeSnapshot } from "@omp-ui/core/vibe";
import { vibeWorkLive } from "@omp-ui/core/vibe";
import type { LimitsView } from "@omp-ui/core/limits";
import type { AutoresearchSnapshot } from "@omp-ui/core/autoresearch";
import { ANONYMIZE_MIN_OMP, supportsAnonymize } from "../lib/anonymize";
import { cn } from "../lib/cn";
import { startVisibleInterval } from "../lib/visible-interval";
import { formatDuration } from "../lib/duration";
import { compactNum, exactNum, formatCost } from "../lib/format";
import { formatHotkey } from "../lib/hotkeys";
import { useCompactShell } from "../lib/responsive";
import { localeTag, useT, type MessageKey } from "../lib/i18n";
import { linkedExperiment } from "../lib/experiment-link";
import { deltaLabel } from "./lab/experiment-state";
import { projectKey } from "../lib/project-key";
import type { ContextUsage, SubagentInfo, UsageLimit } from "../lib/rpc-types";
import { JOB_WIDGET_TONE, backgroundWorkInFlight, freshestWidgetJob, jobWidgetFigure, runningJobCount } from "../lib/async-jobs";
import type { AsyncJob } from "@omp-ui/core/async-jobs";
import { findInstance, findOwner, findRecord, isChatTab, sessionCwd, useStore } from "../store";
import type { RpcTabState } from "../store/types";
import type { SessionSpendSnapshot } from "@omp-ui/core/session-spend";
import { useDismissal } from "../lib/use-dismissal";
import { ConsoleToggle } from "./ConsoleDrawer";
import { BrowserPaneToggle } from "./browser-pane/BrowserPaneToggle";
import { BuildPlanControl } from "./BuildPlanControl";
import { FastModeControl } from "./FastModeControl";
import { AdvisorRosterView } from "./AdvisorRoster";
import { ApprovalModeControl } from "./ApprovalModeControl";
import { GoalChip } from "./GoalChip";
import { WorktreeChip } from "./WorktreeChip";
import { Button, Chevron, Chip, CopyButton, Dot, ICON_STROKE, IconButton, IconLock, IconRefresh, IconSessionTree, Label, Meter, Panel, Sheet, Switch, type Tone } from "./ui";
import { TONE_TEXT } from "./ui/tone";

/**
 * The instrument's status bar: one line that answers "is it alive, what is it
 * called, how full is the context, and what can I do to it right now".
 *
 * On desktop the HUD renders inside App's merged title bar (issue #60): the
 * wide face is liveness, the title menu, status chips and the gauge chip
 * (#941). The compact branch below still renders in-tab inside RpcTab.
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

function IconShare() {
  return (
    <Svg>
      <circle cx="3.2" cy="8" r="1.7" {...ICON_STROKE} />
      <circle cx="12.8" cy="3.8" r="1.7" {...ICON_STROKE} />
      <circle cx="12.8" cy="12.2" r="1.7" {...ICON_STROKE} />
      <path d="M4.8 7.1l6.4-2.7M4.8 8.9l6.4 2.7" {...ICON_STROKE} />
    </Svg>
  );
}

function IconAnonymize() {
  return (
    <Svg>
      <path d="M2 8s2.4-3.4 6-3.4S14 8 14 8s-2.4 3.4-6 3.4S2 8 2 8z" {...ICON_STROKE} />
      <path d="M2.8 2.8l10.4 10.4" {...ICON_STROKE} />
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

function IconRetitle() {
  return (
    <Svg>
      <path d="M2.5 5h8M2.5 8.5h5" {...ICON_STROKE} />
      <path d="M11.2 7.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" {...ICON_STROKE} />
    </Svg>
  );
}

/* --------------------------------------------------------------- fragments */

const STATUS: Record<
  string,
  { tone: Tone; pulse: boolean; labelKey: MessageKey }
> = {
  starting: { tone: "neutral", pulse: true, labelKey: "hud.status.starting" },
  ready: { tone: "signal", pulse: false, labelKey: "hud.status.ready" },
  running: { tone: "copper", pulse: true, labelKey: "hud.status.running" },
  error: { tone: "rose", pulse: false, labelKey: "hud.status.error" },
};

/** Observation-only claim for the stall chip (issue #228, #179). */

/**
 * The live stream-stall chip (issue #228), one component for both HUD
 * faces. The dot has no pulse: ADR-0004 marks "work is happening right
 * now" with the dot's static active halo, and a stalled stream is the
 * negation of that.
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

/**
 * Vibe mode, as the root bridge reports it (issue #683): the glanceable half
 * is mode-on and how many workers are under the director; live work pulses
 * copper like the agent roster does. Clicking opens the Agents pane, which
 * carries the full roster — the chip never duplicates it.
 */
function VibeChip({
  vibe,
  tabId,
  className,
}: {
  vibe: VibeSnapshot;
  tabId: string;
  className?: string;
}) {
  const t = useT();
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const focusRailPane = useStore((s) => s.focusRailPane);
  const working = vibeWorkLive(vibe);
  const title = t(
    working
      ? "hud.vibe.working"
      : vibe.workers.length > 0
        ? "hud.vibe.idleWorkers"
        : "hud.vibe.noWorkers",
    { count: vibe.workers.length },
  );
  return (
    <button
      type="button"
      onClick={() => {
        setInspectorOpen(true);
        focusRailPane(tabId, "agents");
      }}
      title={`${title}. ${t("hud.vibe.openTitle")}`}
      aria-label={title}
      className={cn("shrink-0 rounded border border-transparent", className)}
    >
      <Chip tone="copper" mono>
        {working && <Dot tone="copper" />}
        {t("hud.vibe.label")}
        <span className="opacity-70">{vibe.workers.length}</span>
      </Chip>
    </button>
  );
}
/**
 * Running background jobs (issue #835): the count plus the freshest live
 * widget's figure (#954); the Jobs pane carries the rest. Copper like every
 * other live-work chip (ADR-0004).
 */
function JobsChip({
  count,
  glance,
  tabId,
  className,
}: {
  count: number;
  glance: AsyncJob | null;
  tabId: string;
  className?: string;
}) {
  const t = useT();
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const focusRailPane = useStore((s) => s.focusRailPane);
  const title = t("hud.jobs.running", { count });
  const figure = glance !== null && glance.widget !== null ? jobWidgetFigure(glance.widget) : null;
  const glanceTitle =
    glance !== null && figure !== null
      ? t("hud.jobs.glance", { job: glance.id, figure: [figure.label, figure.text, figure.trend?.text].filter(Boolean).join(" ") })
      : null;
  const openTitle = t("hud.jobs.openTitle");
  return (
    <button
      type="button"
      onClick={() => {
        setInspectorOpen(true);
        focusRailPane(tabId, "jobs");
      }}
      title={glanceTitle !== null ? `${title}. ${glanceTitle}. ${openTitle}` : `${title}. ${openTitle}`}
      aria-label={title}
      className={cn("shrink-0 rounded border border-transparent", className)}
    >
      <Chip tone="copper" mono>
        <Dot tone="copper" />
        {t("hud.jobs.label")}
        <span className="opacity-70">{count}</span>
        {figure !== null && <span data-jobs-glance className="max-w-[10ch] truncate">{figure.text}</span>}
        {figure?.trend && <span className={TONE_TEXT[JOB_WIDGET_TONE[figure.trend.tone]]}>{figure.trend.text}</span>}
      </Chip>
    </button>
  );
}
/**
 * One session's autoresearch mode, as the root bridge reports it (ADR-0030,
 * issue #559). The chip is the glanceable half: is the loop on, is a turn
 * running, which run of the segment, how far the best kept run has moved from
 * the baseline, is a run waiting for its log. Progress comes from the Lab's
 * cached overview — omp's DB is the record of runs, and the chip never reads
 * it directly — linked to this session by checkout and branch; before that
 * cache exists the chip reads it once. Clicking opens the Lab on the linked
 * experiment (or the project's overview while no row exists yet).
 */
function AutoresearchChip({
  snapshot,
  tabId,
  className,
}: {
  snapshot: AutoresearchSnapshot;
  tabId: string;
  className?: string;
}) {
  const t = useT();
  const openLab = useStore((s) => s.openLab);
  const loadExperiments = useStore((s) => s.loadExperiments);
  const tab = useStore((s) => s.tabs.find((candidate) => candidate.tabId === tabId));
  const projectCwd = tab?.projectCwd;
  const instanceId = tab?.instanceId ?? null;
  const summary = useStore((s) => findRecord(s.state, tabId));
  const cache = useStore((s) =>
    projectCwd === undefined ? undefined : s.experiments[projectKey(instanceId, projectCwd)],
  );
  const turnRunning = useStore((s) => s.rpc[tabId]?.status === "running") || summary?.turnRunning === true;
  // Read the overview once for a project the Lab has not visited yet; from
  // then on the snapshot's own acceptance path keeps it fresh.
  const needsExperiments = projectCwd !== undefined && cache === undefined;
  useEffect(() => {
    if (needsExperiments) void loadExperiments(projectCwd, instanceId);
  }, [needsExperiments, projectCwd, instanceId, loadExperiments]);
  const record = linkedExperiment(cache?.result ?? null, tabId, summary)?.record ?? null;
  const progress = record?.progress ?? null;
  const detail: string[] = [];
  if (record !== null && progress !== null) {
    detail.push(
      record.maxIterations === null
        ? t("hud.autoresearch.run", { n: progress.segmentRuns })
        : t("hud.autoresearch.runOf", { n: progress.segmentRuns, cap: record.maxIterations }),
    );
    if (progress.best !== null && progress.baseline !== null) {
      detail.push(
        t("hud.autoresearch.best", {
          delta: deltaLabel(progress.baseline.metric, progress.best.metric),
        }),
      );
    }
    if (progress.pendingRunId !== null) detail.push(t("hud.autoresearch.logPending"));
  }
  const title = t("hud.autoresearch.goal", { goal: snapshot.goal ?? "" });
  return (
    <button
      type="button"
      onClick={() => openLab(projectCwd ?? null, instanceId, { tabId })}
      title={`${title} — ${t("hud.autoresearch.openTitle")}`}
      aria-label={title}
      className={cn("shrink-0 rounded border border-transparent", className)}
    >
      <Chip tone={turnRunning ? "signal" : "copper"} mono>
        {turnRunning && <Dot tone="signal" />}
        {t("hud.autoresearch.on")}
        {detail.length > 0 && <span className="opacity-70">{detail.join(" · ")}</span>}
      </Chip>
    </button>
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
 * The rename input both HUD faces use: the compact sheet's TitleField and the
 * wide face's title menu (#941). Enter commits a trimmed, changed, non-empty
 * name; Escape and blur both abandon.
 */
function TitleRenameInput({ tabId, title, onDone }: { tabId: string; title: string; onDone: () => void }) {
  const t = useT();
  const renameSessionTo = useStore((s) => s.renameSessionTo);
  const [draft, setDraft] = useState(title);
  return (
    <input
      autoFocus
      value={draft}
      aria-label={t("hud.session.nameLabel")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const name = draft.trim();
          onDone();
          if (name && name !== title) void renameSessionTo(tabId, name);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
      className="min-w-0 flex-1 rounded border border-line-strong bg-void px-1.5 py-0.5 font-display text-[13px] text-ink outline-none focus:border-signal-dim [app-region:no-drag]"
    />
  );
}

/**
 * Click-to-rename title with the hover retitle affordance. Compact sheet
 * only; the wide face renames from the title menu (#941).
 */
function TitleField({ tabId, title }: { tabId: string; title: string }) {
  const t = useT();
  const regenerateSessionTitle = useStore((s) => s.regenerateSessionTitle);
  const [editing, setEditing] = useState(false);

  if (editing) return <TitleRenameInput tabId={tabId} title={title} onDone={() => setEditing(false)} />;
  return (
    <span className="group/title flex min-w-0 items-center gap-0.5 [app-region:no-drag]">
      <button
        type="button"
        title={t("hud.session.renameTitle", { title })}
        onClick={() => setEditing(true)}
        className="min-w-0 truncate rounded px-1 py-0.5 text-left font-display text-[13px] text-ink transition-colors hover:bg-hover [app-region:no-drag]"
      >
        {title}
      </button>
      {/* The retitle affordance (issue #433): revealed on hover/focus like
          the sidebar row's controls. */}
      <button
        type="button"
        aria-label={t("hud.session.retitle")}
        title={t("hud.session.retitleTitle", { title })}
        onClick={() => void regenerateSessionTitle(tabId)}
        className="grid size-5 shrink-0 place-items-center rounded text-ink-dim opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-ink group-hover/title:opacity-100 focus-visible:opacity-100 focus-visible:outline-none [app-region:no-drag]"
      >
        <IconRetitle />
      </button>
    </span>
  );
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface ContextReadout {
  window: number;
  fraction: number;
  percent: number;
  /** Auto-compact notch as a 0..1 fraction of the window; null = no notch. */
  marker: number | null;
  /** The exact-usage tooltip. */
  exact: string;
}

/** The context fill math the context meter and the gauge chip share. */
function contextReadout(usage: ContextUsage, markerTokens: number | null | undefined, t: Translate): ContextReadout {
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
  return { window, fraction, percent, marker: threshold?.at ?? null, exact };
}

/** Context percent tone: rose past 90 %, copper past 70 %. */
function percentTone(percent: number): string {
  return percent > 90 ? "text-rose" : percent > 70 ? "text-copper" : "text-ink-dim";
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
  const { window, fraction, percent, marker, exact } = contextReadout(usage, markerTokens, t);
  return (
    <div className="flex shrink-0 items-center gap-2" title={exact}>
      <Meter fraction={fraction} marker={marker} className="titlebar-context-meter w-20" title={exact} />
      <span className="titlebar-context-tokens hidden font-mono text-[11px] tabular-nums text-ink-mid md:inline">
        {compactNum(usage.tokens)} / {window > 0 ? compactNum(window) : "?"}
      </span>
      <span className={cn("font-mono text-[11px] tabular-nums", percentTone(percent))}>
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}

/** Snapshots older than this render faint: a hint, not a live number (issue #673). */
const LIMITS_STALE_MS = 10 * 60 * 1000;
/** Countdown redraw cadence while a future window reset is visible. */
const LIMITS_TICK_MS = 30_000;

/**
 * The provider rate-window readout, as the limits bridge published it
 * (issue #673). Quiet mono chrome: `label percent` pairs colored like the
 * context fill, every window's absolute reset time in the tooltip. The
 * `inline` layout (compact sheet) is one row with the nearest future reset as
 * a countdown; the `list` layout (gauge popover, #941) gives each window its
 * own row with its reset time. Absent — never a placeholder — when the
 * provider reports nothing.
 */
function LimitsCluster({ limits, layout = "inline" }: { limits: LimitsView; layout?: "inline" | "list" }) {
  const t = useT();
  const [, setTick] = useState(0);
  const now = Date.now();
  const hasFutureReset = limits.windows.some(
    (window) => window.resetsAtMs !== null && window.resetsAtMs > now,
  );
  useEffect(() => {
    if (!hasFutureReset) return;
    const stop = startVisibleInterval(() => setTick((n) => n + 1), LIMITS_TICK_MS);
    return stop;
  }, [hasFutureReset]);
  const stale =
    limits.fetchedAtMs > 0 && now - limits.fetchedAtMs > LIMITS_STALE_MS;
  const windows = limits.windows
    .map((window) =>
      t("hud.limits.windowLine", {
        label: window.label,
        percent:
          window.percent !== null
            ? `${window.percent.toFixed(1)}%`
            : t("hud.limits.unknownPercent"),
        reset:
          window.resetsAtMs === null
            ? t("hud.limits.unknownReset")
            : window.resetsAtMs <= now
              ? t("hud.limits.resetNow")
              : new Date(window.resetsAtMs).toLocaleString(localeTag()),
      }),
    )
    .join("\n");
  const details = t("hud.limits.details", {
    provider: limits.provider ?? "?",
    age:
      limits.fetchedAtMs > 0
        ? formatDuration(Math.max(0, now - limits.fetchedAtMs))
        : "?",
    windows,
  });
  const nextReset = limits.windows
    .map((window) => window.resetsAtMs)
    .filter((at): at is number => at !== null && at > now)
    .sort((a, b) => a - b)[0];
  const tone = (percent: number | null): string =>
    stale
      ? "text-ink-faint"
      : percent === null
        ? "text-ink-dim"
        : percent > 90
          ? "text-rose"
          : percent > 70
            ? "text-copper"
            : "text-ink-dim";
  const banked = limits.bankedResets > 0 && (
    <Chip mono title={t("hud.limits.bankedResets", { count: limits.bankedResets })}>
      ×{limits.bankedResets}
    </Chip>
  );
  if (layout === "list") {
    const resetText = (at: number | null): string =>
      at === null
        ? t("hud.limits.unknownReset")
        : at <= now
          ? t("hud.limits.resetNow")
          : t("hud.limits.resetsAt", { time: new Date(at).toLocaleString(localeTag()) }) +
            (stale ? "" : t("hud.limits.resetsIn", { duration: formatDuration(at - now) }));
    return (
      <div className="titlebar-limits flex flex-col gap-1 font-mono text-[10px] tabular-nums" title={details}>
        {limits.windows.map((window) => (
          <div key={window.id} className="flex items-baseline justify-between gap-3">
            <span className={cn("min-w-0 truncate", tone(window.percent))}>
              {window.label}
              {window.percent !== null ? ` ${Math.round(window.percent)}%` : ""}
            </span>
            <span className="shrink-0 text-ink-dim">{resetText(window.resetsAtMs)}</span>
          </div>
        ))}
        {banked && <div>{banked}</div>}
      </div>
    );
  }
  return (
    <div
      className="titlebar-limits flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums"
      title={details}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
        {t("hud.limits.label")}
      </span>
      {limits.windows.map((window) => (
        <span key={window.id} className={cn("tabular-nums", tone(window.percent))}>
          {window.label}
          {window.percent !== null ? ` ${Math.round(window.percent)}%` : ""}
        </span>
      ))}
      {nextReset !== undefined && !stale && (
        <span className="text-ink-dim">
          {t("hud.limits.resetsIn", { duration: formatDuration(nextReset - now) })}
        </span>
      )}
      {banked}
    </div>
  );
}

/**
 * The transient quota chip (issue #673): the retry layer waited on a rate
 * window (`auto_retry_start` carrying the UsageLimit bit) or rotated to a
 * sibling credential (`auto_retry_end` recovery). It lives exactly through
 * the turn that experienced it — the reducer clears it at agent_start — and
 * never claims success: a rotation this frame recorded still rides a turn
 * that may end in the rose transcript marker.
 */
function QuotaChip({
  event,
  className,
}: {
  event: NonNullable<RpcTabState["quotaEvent"]>;
  className?: string;
}) {
  const t = useT();
  const wait =
    event.delayMs !== undefined
      ? t("hud.limits.chipWait", {
          delay: t("hud.limits.chipDelay", { duration: formatDuration(event.delayMs) }),
        })
      : t("hud.limits.chipWait", { delay: "" });
  return event.kind === "rotation" ? (
    <Chip tone="iris" className={className} title={t("hud.limits.chipRotation")}>
      {t("hud.limits.chipRotation")}
    </Chip>
  ) : (
    <Chip tone="copper" className={className} title={wait}>
      {wait}
    </Chip>
  );
}

/**
 * The account-stage chip (issue #777): omp's provider-neutral usageLimit from
 * get_state — the wrap-up allowance or the low-priority lane, with the LOCAL
 * reset clock. Durable until the next full get_state reports the field absent
 * (applyRpcState clears it), unlike the turn-scoped QuotaChip (#673). The
 * countdown re-renders on the same 30 s cadence LimitsCluster rides, armed
 * only while a future reset is visible.
 */
function UsageLimitChip({ usage, className }: { usage: UsageLimit; className?: string }) {
  const t = useT();
  const [, setTick] = useState(0);
  const now = Date.now();
  const resetMs = usage.resetsAtSec === null ? null : usage.resetsAtSec * 1000;
  const hasFutureReset = resetMs !== null && resetMs > now;
  useEffect(() => {
    if (!hasFutureReset) return;
    const stop = startVisibleInterval(() => setTick((n) => n + 1), LIMITS_TICK_MS);
    return stop;
  }, [hasFutureReset]);
  const stage = t(usage.stage === "wrap_up" ? "hud.usage.wrapUp" : "hud.usage.lowPriority");
  const title = [
    resetMs === null
      ? stage
      : t("hud.usage.stageTitle", { stage, time: new Date(resetMs).toLocaleString(localeTag()) }) +
        (usage.stage === "wrap_up" && usage.extraUsage ? t("hud.usage.extraUsage") : ""),
    ...(usage.allowanceLeftPercent !== null
      ? [t("hud.usage.allowanceLeft", { percent: usage.allowanceLeftPercent })]
      : []),
  ].join("\n");
  return (
    <Chip tone="copper" className={className} title={title}>
      {stage}
      {hasFutureReset ? t("hud.usage.resetsIn", { duration: formatDuration(resetMs! - now) }) : ""}
    </Chip>
  );
}

const STEERING_MODES = ["one-at-a-time", "all-at-once"];
const NO_SUBAGENTS: readonly SubagentInfo[] = [];
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

/**
 * The queue-mode, fast, approval and retry controls the title menu swaps in
 * for its rows (#941). The caller's portal wrapper carries the dialog role.
 */
function ModesPanel({
  tabId,
  autoRetry,
  onAutoRetry,
}: {
  tabId: string;
  autoRetry: boolean;
  onAutoRetry: (next: boolean) => void;
}) {
  const t = useT();
  const modeCopy = useModeCopy();
  const session = useStore((s) => s.rpc[tabId]?.session);
  const setSteeringMode = useStore((s) => s.setSteeringMode);
  const setFollowUpMode = useStore((s) => s.setFollowUpMode);
  const setInterruptMode = useStore((s) => s.setInterruptMode);
  const abortRetry = useStore((s) => s.abortRetry);
  return (
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
      {/* Fast mode is always reachable here: the HUD chip hides on plain-off
          sessions, so this row is the desktop entry point (issue #677). The
          row renders through FastModeControl's sheet layout (issue #719) —
          the same component path the composer sheet rides, so the HUD can
          never disagree with the composer about switch vs. tier capsule. */}
      <div className="mt-2">
        <FastModeControl tabId={tabId} layout="sheet" />
      </div>
      {/* Approval mode is always reachable here, like fast mode: the chip
          only marks a pinned session, so this row is the entry point for
          inherit and for un-pinning (issue #681). */}
      <ApprovalModeControl tabId={tabId} layout="sheet" />
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
            onChange={onAutoRetry}
          />
        </div>
      </div>
    </Panel>
  );
}

function CompactModes({
  tabId,
  autoRetry,
  onAutoRetry,
}: {
  tabId: string;
  autoRetry: boolean;
  onAutoRetry: (next: boolean) => void;
}) {
  const t = useT();
  const modeCopy = useModeCopy();
  const session = useStore((s) => s.rpc[tabId]?.session);
  const setSteeringMode = useStore((s) => s.setSteeringMode);
  const setFollowUpMode = useStore((s) => s.setFollowUpMode);
  const setInterruptMode = useStore((s) => s.setInterruptMode);
  const abortRetry = useStore((s) => s.abortRetry);
  return (
    <div className="space-y-3 border-t border-line p-3">
      <ModeRow label={modeCopy.labels.steering} value={session?.steeringMode ?? null} known={STEERING_MODES} onChange={(v) => void setSteeringMode(tabId, v)} hint={modeCopy.rowHints.steering} optionHints={modeCopy.queueHints} />
      <ModeRow label={modeCopy.labels.followUp} value={session?.followUpMode ?? null} known={STEERING_MODES} onChange={(v) => void setFollowUpMode(tabId, v)} hint={modeCopy.rowHints.followUp} optionHints={modeCopy.queueHints} />
      <ModeRow label={modeCopy.labels.interrupt} value={session?.interruptMode ?? null} known={INTERRUPT_MODES} onChange={(v) => void setInterruptMode(tabId, v)} hint={modeCopy.rowHints.interrupt} optionHints={modeCopy.interruptHints} />
      <div className="flex items-center justify-between gap-3 border-t border-line-soft pt-3">
        <Button variant="ghost" tone="rose" onClick={() => void abortRetry(tabId)}>{t("hud.retry.abort")}</Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-mid">{t("hud.retry.autoRetry")}</span>
          <Switch on={autoRetry} label={t("hud.retry.autoRetry")} onChange={onAutoRetry} />
        </div>
      </div>
    </div>
  );
}

/** One title-menu row: WorktreeChip's row text plus a trailing slot. */
const MENU_ROW =
  "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none disabled:pointer-events-none disabled:text-ink-faint";

function MenuGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={heading}>
      <div aria-hidden className="px-2.5 pb-1 pt-2">
        <Label>{heading}</Label>
      </div>
      {children}
    </div>
  );
}

const MENU_SEPARATOR = <div className="my-1 border-t border-line-soft" />;

/** Arrow/Home/End roving focus over the menu's enabled items; Escape stays with useDismissal. */
function rovingFocus(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'));
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? (current + 1) % items.length
          : current <= 0
            ? items.length - 1
            : current - 1;
  items[next]?.focus();
}

/**
 * The wide face's title menu (#941): the session title as a menu button that
 * holds every session action — rename and retitle, the View toggles, Session
 * and Share actions, Capabilities, the modes panel and refresh. Portal and
 * dismissal follow WorktreeChip; Escape restores focus to the trigger.
 */
function TitleMenu({
  tabId,
  title,
  chat,
  projectCwd,
  instanceId,
  compacting,
  treeAvailable,
  anonAvailable,
  mcpFailureCount,
  autoRetry,
  onAutoRetry,
  onRefresh,
}: {
  tabId: string;
  title: string;
  chat: boolean;
  projectCwd: string | undefined;
  instanceId: string | null;
  compacting: boolean;
  treeAvailable: boolean;
  anonAvailable: boolean;
  mcpFailureCount: number;
  autoRetry: boolean;
  onAutoRetry: (next: boolean) => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const regenerateSessionTitle = useStore((s) => s.regenerateSessionTitle);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const toggleBrowserPane = useStore((s) => s.toggleBrowserPane);
  const branchSession = useStore((s) => s.branchSession);
  const openSessionTreeView = useStore((s) => s.openSessionTreeView);
  const newSession = useStore((s) => s.newSession);
  const newChat = useStore((s) => s.newChat);
  const compactSession = useStore((s) => s.compactSession);
  const exportHtml = useStore((s) => s.exportHtml);
  const shareSession = useStore((s) => s.shareSession);
  const anonymizeSession = useStore((s) => s.anonymizeSession);
  const openCapabilitiesViewer = useStore((s) => s.openCapabilitiesViewer);
  const consoleOpen = useStore((s) => s.consoleOpen[tabId] === true);
  const paneOpen = useStore((s) => s.rpc[tabId]?.browserPane.open === true);
  const [surface, setSurface] = useState<null | "menu" | "modes">(null);
  const [editing, setEditing] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (): void => setSurface(null);
  const toggle = (): void => {
    if (surface !== null) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ x: rect.left, y: rect.bottom + 4 });
    setSurface("menu");
  };
  // Every action row closes the menu before it fires.
  const act = (fire: () => void) => () => {
    close();
    fire();
  };

  useDismissal({
    open: surface !== null,
    refs: [rootRef, panelRef],
    onClose: close,
    onEscape: close,
    restoreFocus: () => triggerRef.current?.focus(),
  });

  useEffect(() => {
    if (surface !== "menu") return;
    panelRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [surface]);

  const checkRow = (label: string, checked: boolean, hotkey: string | null, onClick: () => void): ReactNode => (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={act(onClick)} className={MENU_ROW}>
      <span className={cn("flex min-w-0 items-center gap-1.5", checked && "text-ink")}>
        {checked && <span aria-hidden>✓</span>}
        {label}
      </span>
      {hotkey !== null && <span className="font-mono text-[10px] text-ink-faint">{hotkey}</span>}
    </button>
  );
  const anonNeedsOmp = t("hud.actions.anonymizeNeedsOmp", { version: ANONYMIZE_MIN_OMP });

  return (
    <span ref={rootRef} className="flex min-w-16 shrink items-center [app-region:no-drag]">
      {editing ? (
        <TitleRenameInput tabId={tabId} title={title} onDone={() => setEditing(false)} />
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={surface === "menu"}
          title={t("hud.menu.triggerTitle", { title })}
          onClick={toggle}
          className="flex min-w-0 max-w-[28rem] items-center gap-1 rounded px-1 py-0.5 font-display text-[13px] text-ink transition-colors hover:bg-hover"
        >
          <span className="min-w-0 truncate">{title}</span>
          <Chevron open className="text-ink-dim" />
        </button>
      )}
      {surface !== null &&
        pos !== null &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[70]"
            style={{ left: pos.x, top: pos.y }}
            {...(surface === "menu"
              ? { role: "menu", "aria-label": t("hud.menu.label"), onKeyDown: rovingFocus }
              : { role: "dialog", "aria-label": t("hud.modes.controlLabel") })}
          >
            {surface === "menu" ? (
              <Panel className="edge-lit animate-rise max-h-[calc(100vh-3rem)] w-64 overflow-y-auto p-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setEditing(true);
                  }}
                  className={MENU_ROW}
                >
                  {t("hud.menu.rename")}
                </button>
                {/* Never disabled: a fresh session retitles too (#788). */}
                <button
                  type="button"
                  role="menuitem"
                  title={t("hud.session.retitleTitle", { title })}
                  onClick={act(() => void regenerateSessionTitle(tabId))}
                  className={MENU_ROW}
                >
                  {t("hud.menu.retitle")}
                </button>
                <MenuGroup heading={t("hud.menu.view")}>
                  {checkRow(t("hud.menu.console"), consoleOpen, formatHotkey("mod+j"), () => toggleConsole(tabId))}
                  {checkRow(t("hud.menu.browserPane"), paneOpen, null, () => toggleBrowserPane(tabId))}
                </MenuGroup>
                {MENU_SEPARATOR}
                <MenuGroup heading={t("hud.menu.session")}>
                  <button
                    type="button"
                    role="menuitem"
                    title={t("hud.actions.branchTitle")}
                    onClick={act(() => void branchSession(tabId))}
                    className={MENU_ROW}
                  >
                    {t("hud.menu.branch")}
                  </button>
                  {/* The tree navigator needs a live process (#680). */}
                  {treeAvailable && (
                    <button
                      type="button"
                      role="menuitem"
                      title={t("hud.actions.treeTitle")}
                      onClick={act(() => openSessionTreeView(tabId))}
                      className={MENU_ROW}
                    >
                      {t("hud.menu.tree")}
                    </button>
                  )}
                  {/* Same command as the composer's bare /new and mod+shift+n: a
                      new live session tab in this project, not an in-tab reset (#82). */}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!chat && projectCwd === undefined}
                    onClick={act(() => {
                      if (chat) void newChat();
                      else if (projectCwd !== undefined) void newSession(projectCwd, undefined, instanceId);
                    })}
                    className={MENU_ROW}
                  >
                    {chat ? t("hud.menu.newChat") : t("hud.menu.newHere")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title={t("hud.actions.compactTitle")}
                    disabled={compacting}
                    onClick={act(() => void compactSession(tabId))}
                    className={MENU_ROW}
                  >
                    {t("hud.menu.compact")}
                  </button>
                </MenuGroup>
                {MENU_SEPARATOR}
                <MenuGroup heading={t("hud.menu.share")}>
                  <button type="button" role="menuitem" onClick={act(() => void exportHtml(tabId))} className={MENU_ROW}>
                    {t("hud.menu.export")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title={t("hud.actions.shareTitle")}
                    onClick={act(() => void shareSession(tabId))}
                    className={MENU_ROW}
                  >
                    {t("hud.menu.publish")}
                  </button>
                  {/* A disabled row gets no hover title (pointer-events-none), so
                      the needs-omp reason also renders as a second line (#834). */}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!anonAvailable}
                    title={anonAvailable ? t("hud.actions.anonymizeTitle") : anonNeedsOmp}
                    onClick={act(() => void anonymizeSession(tabId))}
                    className={MENU_ROW}
                  >
                    <span className="min-w-0">
                      {t("hud.menu.redacted")}
                      {!anonAvailable && <span className="block text-[10px] text-ink-faint">{anonNeedsOmp}</span>}
                    </span>
                  </button>
                </MenuGroup>
                {MENU_SEPARATOR}
                {/* The global catalog (#383); the count is THIS session's failed MCP servers. */}
                <button
                  type="button"
                  role="menuitem"
                  onClick={act(() => openCapabilitiesViewer(null, undefined, "mcp", instanceId))}
                  className={MENU_ROW}
                >
                  {t("hud.actions.capabilities")}
                  {mcpFailureCount > 0 && <Chip tone="rose">{t("hud.actions.failureCount", { count: mcpFailureCount })}</Chip>}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="dialog"
                  onClick={() => setSurface("modes")}
                  className={MENU_ROW}
                >
                  {t("hud.menu.modes")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  title={t("hud.actions.refreshTitle")}
                  onClick={act(onRefresh)}
                  className={MENU_ROW}
                >
                  {t("hud.menu.refresh")}
                </button>
              </Panel>
            ) : (
              <ModesPanel tabId={tabId} autoRetry={autoRetry} onAutoRetry={onAutoRetry} />
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}

const RING_TONE = { signal: "stroke-signal", copper: "stroke-copper", rose: "stroke-rose" } as const;

/** The gauge chip's decorative context ring; tone thresholds match Meter. */
function GaugeRing({ fraction }: { fraction: number }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const tone = clamped > 0.9 ? "rose" : clamped > 0.7 ? "copper" : "signal";
  const r = 6;
  const circumference = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0 -rotate-90">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth={2} className="stroke-line" />
      {clamped > 0 && (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          className={RING_TONE[tone]}
          strokeDasharray={`${clamped * circumference} ${circumference}`}
        />
      )}
    </svg>
  );
}

interface MainSpend {
  cost: number;
  tokens: number;
  premium: number;
  title: string;
}

const GAUGE_SECTION = "mt-2.5 border-t border-line-soft pt-2.5 first:mt-0 first:border-t-0 first:pt-0";
const GAUGE_HEADER = "flex items-center justify-between gap-3";

/**
 * The wide face's gauge chip (#941): context ring, rounded fill and
 * whole-session spend. Its popover holds every readout the title bar used to
 * carry inline — context meter, compaction controls, spend breakdown, quota
 * windows, the advisor readout and roster, and extension notices. Always
 * rendered, so auto-compact stays reachable before the first usage report.
 */
function GaugeChip({
  tabId,
  usage,
  markerTokens,
  mainSpend,
  sessionSpend,
  limits,
  advisor,
  notices,
  compacting,
  autoCompaction,
  instanceId,
  cwd,
  rosterProjectCwd,
}: {
  tabId: string;
  usage: ContextUsage | null;
  markerTokens: number | null;
  mainSpend: MainSpend | null;
  sessionSpend: SessionSpendSnapshot | null;
  /** Only when available with at least one window. */
  limits: LimitsView | null;
  /** Only when the advisor readout should show. */
  advisor: AdvisorStatsView | null;
  notices: [string, string][];
  compacting: boolean;
  autoCompaction: boolean;
  instanceId: string | null;
  cwd: string | null;
  /** The project whose advisor settings the roster edits; null = no edit. */
  rosterProjectCwd: string | null;
}) {
  const t = useT();
  const compactSession = useStore((s) => s.compactSession);
  const setAutoCompaction = useStore((s) => s.setAutoCompaction);
  const openProjectSettings = useStore((s) => s.openProjectSettings);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Portaled + fixed: the HUD root is overflow-hidden inside the h-9 title
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
  const close = (): void => setOpen(false);
  useDismissal({
    open,
    refs: [anchor, panelRef],
    onClose: close,
    onEscape: close,
    restoreFocus: () => buttonRef.current?.focus(),
  });

  const readout = usage ? contextReadout(usage, markerTokens, t) : null;
  let advisorReadout: ReactNode = null;
  if (advisor) {
    const ctxWindow = advisor.contextWindow > 0 ? advisor.contextWindow : 0;
    const percent = ctxWindow > 0 ? (advisor.contextTokens / ctxWindow) * 100 : 0;
    // A subscription-billed root advisor legitimately accrues $0. Descendant
    // usage can still make the session-tree total nonzero, which stays numeric.
    const subscribed = advisor.subscription && advisor.cost === 0;
    const exact = t("hud.advisor.contextUsage", {
      model: advisor.model ? ` · ${advisor.model}` : "",
      tokens: exactNum(advisor.contextTokens),
      window: ctxWindow > 0 ? exactNum(ctxWindow) : "?",
      percent: percent.toFixed(2),
      billing: subscribed
        ? t("hud.advisor.subscriptionBilling")
        : t("hud.advisor.sessionSpend", { cost: formatCost(advisor.cost) }),
      totalTokens: exactNum(advisor.totalTokens),
    });
    advisorReadout = (
      <span className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums" title={exact}>
        <Meter fraction={ctxWindow > 0 ? advisor.contextTokens / ctxWindow : 0} className="w-14" title={exact} />
        <span className="text-ink-dim">{percent.toFixed(1)}%</span>
        <span className="text-ink-faint">{subscribed ? t("hud.advisor.subscriptionShort") : formatCost(advisor.cost)}</span>
      </span>
    );
  }

  return (
    <div ref={anchor} className="relative shrink-0 [app-region:no-drag]">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("hud.gauge.label")}
        title={[readout?.exact, mainSpend?.title].filter(Boolean).join("\n")}
        onClick={() => setOpen(!open)}
        className={cn(
          "titlebar-gauge flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors hover:bg-hover",
          open && "bg-hover",
        )}
      >
        <GaugeRing fraction={readout?.fraction ?? 0} />
        <span className={readout ? percentTone(readout.percent) : "text-ink-dim"}>
          {readout ? `${Math.round(readout.percent)}%` : "—"}
        </span>
        {mainSpend && <span className="titlebar-gauge-cost text-ink-faint">{formatCost(mainSpend.cost)}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={panelRef} role="dialog" aria-label={t("hud.gauge.label")} className="fixed z-[70]" style={pos}>
            <Panel className="edge-lit animate-rise max-h-[calc(100vh-3rem)] w-[22rem] overflow-y-auto p-3 text-[11px]">
              {usage && (
                <div className={cn(GAUGE_SECTION, GAUGE_HEADER)}>
                  <Label>{t("hud.metrics.context")}</Label>
                  <ContextCluster usage={usage} markerTokens={markerTokens} />
                </div>
              )}
              <div className={cn(GAUGE_SECTION, GAUGE_HEADER)}>
                <Button
                  size="xs"
                  variant="ghost"
                  tone="copper"
                  title={t("hud.actions.compactTitle")}
                  disabled={compacting}
                  onClick={() => void compactSession(tabId)}
                >
                  {t("hud.menu.compact")}
                </Button>
                {/* Label and switch stay adjacent: Switch renders no visible
                    text, so proximity is the only association (issue #79). */}
                <span className="flex items-center gap-2">
                  <span className="text-ink-mid">{t("hud.actions.autoCompact")}</span>
                  <Switch
                    on={autoCompaction}
                    label={t("hud.actions.autoCompact")}
                    title={t("hud.actions.autoCompactTitle")}
                    onChange={(next) => void setAutoCompaction(tabId, next)}
                  />
                </span>
              </div>
              {/* Whole-session spend when the bridge has answered (issue #866),
                  else get_session_stats' context-scoped figure. */}
              {mainSpend && (
                <div className={cn(GAUGE_SECTION, "gauge-spend space-y-1")}>
                  <div className={GAUGE_HEADER}>
                    <Label>{t("hud.metrics.spend")}</Label>
                    <span className="font-mono tabular-nums text-ink-mid" title={mainSpend.title}>
                      {t("hud.stats.compact", {
                        cost: formatCost(mainSpend.cost),
                        tokens: compactNum(mainSpend.tokens),
                        premium: mainSpend.premium,
                      })}
                    </span>
                  </div>
                  {sessionSpend?.available && (
                    <>
                      <div className={cn(GAUGE_HEADER, "pl-2 text-ink-dim")}>
                        <span>{t("hud.gauge.main")}</span>
                        <span className="font-mono tabular-nums">{formatCost(sessionSpend.main.cost)}</span>
                      </div>
                      <div className={cn(GAUGE_HEADER, "pl-2 text-ink-dim")}>
                        <span>{t("hud.gauge.subagents", { count: sessionSpend.transcripts })}</span>
                        <span className="font-mono tabular-nums">{formatCost(sessionSpend.subagents.cost)}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
              {limits && (
                <div className={cn(GAUGE_SECTION, "space-y-1.5")}>
                  <Label>{t("hud.limits.label")}</Label>
                  <LimitsCluster limits={limits} layout="list" />
                </div>
              )}
              {advisor && (
                <div className={cn(GAUGE_SECTION, "gauge-advisor space-y-2")}>
                  <div className={GAUGE_HEADER}>
                    <Label>{t("hud.gauge.advisor")}</Label>
                    {advisorReadout}
                  </div>
                  <AdvisorRosterView
                    tabId={tabId}
                    instanceId={instanceId}
                    cwd={cwd}
                    onEdit={
                      rosterProjectCwd === null
                        ? undefined
                        : () => {
                            close();
                            openProjectSettings(rosterProjectCwd, instanceId, "advisors");
                          }
                    }
                  />
                  <div className={GAUGE_HEADER}>
                    <Label>{t("hud.metrics.advisorTotal")}</Label>
                    <span
                      className="font-mono tabular-nums text-ink-mid"
                      title={t("hud.advisor.totalUsage", { tokens: exactNum(advisor.totalTokens), cost: formatCost(advisor.cost) })}
                    >
                      {t("hud.advisor.compactTotal", {
                        tokens: compactNum(advisor.totalTokens),
                        spend: advisor.subscription && advisor.cost === 0 ? t("hud.advisor.subscriptionShort") : formatCost(advisor.cost),
                      })}
                    </span>
                  </div>
                </div>
              )}
              {notices.length > 0 && (
                <div className={cn(GAUGE_SECTION, "space-y-1.5")}>
                  <Label>{t("hud.gauge.notices")}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {notices.map(([key, text]) => (
                      <Chip key={key} mono title={`${key}: ${text}`}>
                        {text}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ---------------------------------------------------------------- the HUD */

export function SessionHud({ tabId }: { tabId: string }) {
  const t = useT();
  const setAutoRetry = useStore((s) => s.setAutoRetry);
  const [autoRetry, setAutoRetryLocal] = useState(true);
  const updateAutoRetry = (next: boolean): void => {
    setAutoRetryLocal(next);
    void setAutoRetry(tabId, next);
  };
  const status = useStore((s) => s.rpc[tabId]?.status) ?? "starting";
  // Hibernation overrides the (stale) rpc status: the process is stopped on
  // purpose, not live (issue #246). Neutral, no pulse — the mint signal
  // accent is reserved for liveness (ADR-0004), matching the sidebar's
  // dormant style.
  const hibernated = useStore((s) => s.hibernated[tabId] === true);
  // A manual compaction this renderer started whose ack has not landed. The
  // authoritative "compacting" signal while omp's serial chain is blocked:
  // `session.isCompacting` arrives through get_state, and every poll queues
  // behind that same chain, so it reads stale for the whole compaction
  // (issue #625).
  const compacting = useStore((s) => s.rpc[tabId]?.compacting !== undefined);
  const session = useStore((s) => s.rpc[tabId]?.session);
  const stats = useStore((s) => s.rpc[tabId]?.stats);
  // Whole-session spend (issue #866): root + every subagent transcript,
  // surviving compaction. `stats` stays the fallback until the bridge answers.
  const sessionSpend = useStore((s) => s.rpc[tabId]?.sessionSpend ?? null);
  const mainSpend = sessionSpend?.available
    ? {
        cost: sessionSpend.total.cost,
        tokens: sessionSpend.total.totalTokens,
        premium: sessionSpend.total.premiumRequests,
        title: t("hud.stats.sessionDetails", {
          cost: formatCost(sessionSpend.total.cost),
          tokens: exactNum(sessionSpend.total.totalTokens),
          premium: sessionSpend.total.premiumRequests,
          main: formatCost(sessionSpend.main.cost),
          subagents: formatCost(sessionSpend.subagents.cost),
          count: sessionSpend.transcripts,
        }),
      }
    : stats
      ? {
          cost: stats.cost,
          tokens: stats.tokens.total,
          premium: stats.premiumRequests,
          title: t("hud.stats.details", { cost: formatCost(stats.cost), tokens: exactNum(stats.tokens.total), premium: stats.premiumRequests }),
        }
      : null;
  const extensionStatus = useStore((s) => s.rpc[tabId]?.extensionStatus);
  const title = useStore((s) => findRecord(s.state, tabId)?.title);
  // The owning remote instance (issue #416): the nickname chip, and the target
  // of every project-scoped action this HUD fires (new session, capabilities).
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const instance = useStore((s) => (instanceId === null ? undefined : findInstance(s.state, instanceId)));
  // Fleet provenance (issue #899): who dispatched this session, as a quiet chip.
  const fleetFrom = useStore((s) => findRecord(s.state, tabId)?.fleet?.requestedBy ?? null);
  const compactSession = useStore((s) => s.compactSession);
  const setAutoCompaction = useStore((s) => s.setAutoCompaction);
  const exportHtml = useStore((s) => s.exportHtml);
  const shareSession = useStore((s) => s.shareSession);
  const anonymizeSession = useStore((s) => s.anonymizeSession);
  const branchSession = useStore((s) => s.branchSession);
  // Share anonymized (issue #834): the floor rides the installed binary's
  // version — the same source the store action gates on.
  const anonAvailable = useStore((s) => supportsAnonymize(s.ompUpdate.installedVersion));
  const newSession = useStore((s) => s.newSession);
  const newChat = useStore((s) => s.newChat);
  const chat = useStore((s) => isChatTab(s.state, tabId));
  const refreshState = useStore((s) => s.refreshState);
  const refreshStats = useStore((s) => s.refreshStats);
  const refreshAdvisorStats = useStore((s) => s.refreshAdvisorStats);
  const refreshLimits = useStore((s) => s.refreshLimits);
  const advisor = useStore((s) => findRecord(s.state, tabId)?.advisor);
  const approvalMode = useStore((s) => findRecord(s.state, tabId)?.approvalMode ?? null);
  const isPrivate = useStore((s) => findRecord(s.state, tabId)?.private === true);
  const advisorStats = useStore((s) => s.rpc[tabId]?.advisorStats);
  const mcpFailureCount = useStore((s) => s.rpc[tabId]?.mcpStatus?.failedServers.length ?? 0);
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const goal = useStore((s) => s.rpc[tabId]?.goal);
  const vibe = useStore((s) => s.rpc[tabId]?.vibe);
  const autoresearch = useStore((s) => s.rpc[tabId]?.autoresearch);
  const limits = useStore((s) => s.rpc[tabId]?.limits);
  const jobsCount = useStore((s) =>
    runningJobCount(s.rpc[tabId]?.asyncJobs ?? null, s.rpc[tabId]?.subagents ?? NO_SUBAGENTS),
  );
  // The chip label agrees with the sidebar row (issue #434): a ready tab
  // whose bridge still reports a running job is working, not idle (#851).
  const backgroundWork = useStore((s) =>
    backgroundWorkInFlight(s.rpc[tabId]?.asyncJobs ?? null),
  );
  const jobsGlance = useStore((s) => freshestWidgetJob(s.rpc[tabId]?.asyncJobs ?? null));
  const refreshAsyncJobs = useStore((s) => s.refreshAsyncJobs);
  const refreshSessionSpend = useStore((s) => s.refreshSessionSpend);
  // The live session model (frame-owned since config_update): omp resolves
  // compaction.modelThresholds against provider/id, so the notch moves with a
  // model switch (issue #831). null before the first config_update → global path.
  const model = useStore((s) => s.rpc[tabId]?.model);
  const quotaEvent = useStore((s) => s.rpc[tabId]?.quotaEvent);
  const defaultAgentMode = useStore((s) => s.state?.defaultAgentMode ?? "plan");
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd);
  const cwd = useStore((s) => sessionCwd(findRecord(s.state, tabId))) ?? null;
  const openProjectSettingsForRoster = useStore((s) => s.openProjectSettings);
  const worktree = useStore((s) => findRecord(s.state, tabId)?.worktree);
  const openCapabilitiesViewer = useStore((s) => s.openCapabilitiesViewer);
  const openSessionTreeView = useStore((s) => s.openSessionTreeView);
  // The tree navigator needs a live process (its bridge publishes over
  // setStatus); a dormant tab hides it (issue #680).
  const treeAvailable = useStore((s) => {
    const rec = findRecord(s.state, tabId);
    return rec?.live === "live" && rec.mode === "rpc-ui";
  });
  const compact = useCompactShell();
  const surface = useStore((s) => s.compactSurface);
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const streamStallMs = useStore((s) => s.rpc[tabId]?.streamStallMs);
  const ensureCompactionSettings = useStore((s) => s.ensureCompactionSettings);
  const compactionSettings = useStore((s) =>
    projectCwd !== undefined ? s.compactionSettings[projectCwd] : undefined,
  );

  // The quota windows render only when the bridge reached a provider that
  // reports windows; an unavailable or empty snapshot renders nothing (#673).
  const limitsReady = limits?.available === true && limits.windows.length > 0 ? limits : null;
  const limitsCluster = limitsReady !== null && (
    <span className="shrink-0">
      <LimitsCluster limits={limitsReady} />
    </span>
  );
  const quotaChip = quotaEvent != null && (
    <QuotaChip
      event={quotaEvent}
      className={compact ? undefined : "shrink-0 [app-region:no-drag]"}
    />
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
      ? compactionThresholdTokens(usage.contextWindow, compactionSettings,
          model ? { provider: model.provider, id: model.id } : null)
      : null;
  const face = hibernated
    ? null
    : status === "ready" && backgroundWork
      ? STATUS.running
      : (STATUS[status] ?? STATUS.starting);
  const resolvedFace = face ?? { ...STATUS.starting, pulse: false };
  const label = hibernated
    ? t("hud.status.hibernated")
    : t(resolvedFace.labelKey);
  const notices = Object.entries(extensionStatus ?? {}).filter(([, text]) => text.trim() !== "");
  const activeAgentMode = plan == null ? null : plan.enabled ? "plan" : "build";
  const exceptionalAgentMode =
    !chat && activeAgentMode !== null && activeAgentMode !== defaultAgentMode ? activeAgentMode : null;
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
  // The goal chip renders in both faces beside the mode chip, inside a no-drag
  // box in the wide HUD like every other control in that row.
  const goalChip = goal != null && (
    <GoalChip
      state={goal}
      tabId={tabId}
      className={compact ? undefined : "shrink-0 [app-region:no-drag]"}
    />
  );
  // The vibe chip sits beside the goal chip while the director mode is on
  // (issue #683); the goal and vibe modes are mutually exclusive, so at most
  // one of the two renders.
  const vibeChip = vibe?.enabled === true && (
    <VibeChip
      vibe={vibe}
      tabId={tabId}
      className={compact ? undefined : "shrink-0 [app-region:no-drag]"}
    />
  );
  // The jobs chip rides the same row while any background job runs (#835).
  const jobsChip = jobsCount > 0 && (
    <JobsChip count={jobsCount} glance={jobsGlance} tabId={tabId} className={compact ? undefined : "shrink-0 [app-region:no-drag]"} />
  );
  // The autoresearch chip sits beside it while omp's mode is on (ADR-0030).
  const autoresearchChip = autoresearch?.mode === "on" && (
    <AutoresearchChip
      snapshot={autoresearch}
      tabId={tabId}
      className={compact ? undefined : "shrink-0 [app-region:no-drag]"}
    />
  );
  // Fast mode renders its chip only when the setting or the truth is on, so
  // an ordinary session's row stays quiet; the modes popover carries the
  // always-available toggle (issue #677).
  const fastChip =
    (session?.fastModeEnabled === true || session?.fastModeActive === true) && (
      <FastModeControl
        tabId={tabId}
        disabled={status === "starting"}
        className={compact ? "shrink-0" : "shrink-0 [app-region:no-drag]"}
      />
    );
  // Durable until the next full get_state reports usageLimit absent; the chip
  // is null outside both account stages (issue #777).
  const usageLimitChip = session?.usageLimit != null && (
    <UsageLimitChip
      usage={session.usageLimit}
      className={compact ? undefined : "shrink-0 [app-region:no-drag]"}
    />
  );
  // Which host this session lives on (issue #416): quiet mono chip, the URL in
  // the tooltip. Local sessions carry no chip — most sessions are local, and a
  // "this app" chip on every one would say nothing.
  // The pinned approval tier (issue #681): quiet by default — an inheriting
  // session renders no chip, mirroring the fastChip gating above.
  const approvalChip = approvalMode !== null && (
    <ApprovalModeControl
      tabId={tabId}
      className={compact ? "shrink-0" : "shrink-0 [app-region:no-drag]"}
    />
  );
  const instanceChip = instance !== undefined && (
    <Chip mono title={instance.url} className={compact ? undefined : "shrink-0 [app-region:no-drag]"}>
      {instance.nickname}
    </Chip>
  );
  const fleetChip = fleetFrom !== null && (
    <Chip mono className={compact ? undefined : "shrink-0 [app-region:no-drag]"}>
      {t(fleetFrom.kind === "agent" ? "fleet.hud.dispatchedFromAgent" : "fleet.hud.dispatchedFrom", {
        label: fleetFrom.label,
      })}
    </Chip>
  );


  const refresh = () => {
    void refreshState(tabId);
    void refreshStats(tabId);
    if (status !== "running" && session?.isStreaming !== true) void refreshAdvisorStats(tabId);
    void refreshLimits(tabId);
    void refreshAsyncJobs(tabId);
    void refreshSessionSpend(tabId);
  };

  if (compact) {
    const sheetAction = "min-h-11 justify-start gap-2 px-3 text-xs";
    return (
      <>
        <header className="ambient flex min-h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-sunken pl-3 pr-1">
          <LivenessBadge compacting={session?.isCompacting === true || compacting} stallMs={streamStallMs} face={resolvedFace} label={label} short />
          {instanceChip}
          {fleetChip}
          {agentModeChip}
          {goalChip}
          {vibeChip}
          {jobsChip}
          {autoresearchChip}
          {fastChip}
          {approvalChip}
          <span className="min-w-0 flex-1" />
          {usage && <ContextCluster usage={usage} markerTokens={markerTokens} />}
          <ConsoleToggle tabId={tabId} className="size-11" />
          <BrowserPaneToggle tabId={tabId} className="size-11" />
          <IconButton label={t("hud.actions.sessionActions")} onClick={() => showCompactSurface("session-actions")} className="size-11">
            <IconKebab />
            <span className="sr-only">{t("hud.actions.sessionActions")}</span>
          </IconButton>
        </header>
        <Sheet open={surface === "session-actions"} placement="bottom" label={t("hud.actions.sessionActions")} onClose={closeCompactSurface}>
          <div className="space-y-4 p-4">
            <TitleField tabId={tabId} title={title ?? t("hud.session.untitled")} />
            {(usage || mainSpend || advisorStats?.available === true || notices.length > 0 || worktree || quotaEvent != null || usageLimitChip || limitsCluster || isPrivate) && (
              <div className="space-y-2 rounded-lg border border-line bg-raised/60 p-3">
                {worktree && <div className="space-y-1"><div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.worktree")}</Label><span className="flex items-center gap-1"><Chip mono title={worktree.path}>⎇ {worktree.branch}</Chip><CopyButton text={worktree.branch} label={t("hud.actions.copy")} doneLabel={t("hud.actions.copied")} /></span></div><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-mono text-[10px] text-ink-faint" title={worktree.path}>{worktree.path}</span><CopyButton text={worktree.path} label={t("hud.actions.copy")} doneLabel={t("hud.actions.copied")} /></div></div>}
                {isPrivate && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.memory")}</Label><span className="flex items-center gap-1 text-ink-mid"><IconLock /><span title={t("session.badge.private")}>{t("hud.metrics.memoryPrivate")}</span></span></div>}
                {usage && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.context")}</Label><ContextCluster usage={usage} markerTokens={markerTokens} /></div>}
                {mainSpend && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.spend")}</Label><span className="font-mono text-xs tabular-nums text-ink-mid" title={mainSpend.title}>{t("hud.stats.compact", { cost: formatCost(mainSpend.cost), tokens: compactNum(mainSpend.tokens), premium: mainSpend.premium })}</span></div>}
                {quotaEvent != null && <div className="flex items-center justify-between gap-3"><Label>{t("hud.limits.label")}</Label>{quotaChip}</div>}
                {usageLimitChip && <div className="flex items-center justify-between gap-3"><Label>{t("hud.limits.label")}</Label>{usageLimitChip}</div>}
                {limitsCluster && <div className="flex items-center justify-between gap-3"><Label>{t("hud.limits.label")}</Label>{limitsCluster}</div>}
                {showAdvisor && (advisorStats.advisors.length > 0 || advisorStats.configWarnings.length > 0) && <AdvisorRosterView tabId={tabId} instanceId={instanceId} cwd={cwd} onEdit={projectCwd && !chat ? () => openProjectSettingsForRoster(projectCwd, instanceId, "advisors") : undefined} />}
                {showAdvisor && <div className="flex items-center justify-between gap-3"><Label>{t("hud.metrics.advisorTotal")}</Label><span className="font-mono text-xs tabular-nums text-ink-mid" title={t("hud.advisor.totalUsage", { tokens: exactNum(advisorStats.totalTokens), cost: formatCost(advisorStats.cost) })}>{t("hud.advisor.compactTotal", { tokens: compactNum(advisorStats.totalTokens), spend: advisorStats.subscription && advisorStats.cost === 0 ? t("hud.advisor.subscriptionShort") : formatCost(advisorStats.cost) })}</span></div>}
                {notices.length > 0 && <div className="flex flex-wrap gap-1.5">{notices.map(([key, text]) => <Chip key={key} mono title={key}>{text}</Chip>)}</div>}
              </div>
            )}
            <div>
              <Label>{t("hud.actions.heading")}</Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {!chat && <BuildPlanControl tabId={tabId} layout="sheet" className={sheetAction} />}
                <Button tone="copper" disabled={session?.isCompacting === true || compacting} onClick={() => void compactSession(tabId)} className={sheetAction}><IconCompact />{t("hud.actions.compact")}</Button>
                <Button onClick={() => void exportHtml(tabId)} className={sheetAction}><IconExport />{t("hud.actions.export")}</Button>
                <Button title={t("hud.actions.shareTitle")} onClick={() => void shareSession(tabId)} className={sheetAction}><IconShare />{t("hud.actions.share")}</Button>
                <Button
                  disabled={!anonAvailable}
                  title={anonAvailable ? t("hud.actions.anonymizeTitle") : t("hud.actions.anonymizeNeedsOmp", { version: ANONYMIZE_MIN_OMP })}
                  onClick={() => void anonymizeSession(tabId)}
                  className={sheetAction}
                ><IconAnonymize />{t("hud.actions.anonymize")}</Button>
                <Button onClick={() => openCapabilitiesViewer(null, undefined, "mcp", instanceId)} className={sheetAction}><IconMcp />{t("hud.actions.capabilities")}{mcpFailureCount > 0 && <Chip tone="rose" className="ml-auto">{t("hud.actions.failureCount", { count: mcpFailureCount })}</Chip>}</Button>
                <Button title={t("hud.actions.branchTitle")} onClick={() => void branchSession(tabId)} className={sheetAction}><IconBranch />{t("hud.actions.branch")}</Button>
                {treeAvailable && (
                  <Button title={t("hud.actions.treeTitle")} onClick={() => openSessionTreeView(tabId)} className={sheetAction}><IconSessionTree />{t("hud.actions.tree")}</Button>
                )}
                <Button disabled={!chat && projectCwd === undefined} onClick={() => { if (chat) void newChat(); else if (projectCwd !== undefined) void newSession(projectCwd, undefined, instanceId); }} className={sheetAction}><IconNew />{t("hud.actions.new")}</Button>
                <Button onClick={refresh} className={sheetAction}><IconRefresh />{t("hud.actions.refresh")}</Button>
                <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-line px-3"><span className="text-xs">{t("hud.actions.autoCompact")}</span><Switch on={session?.autoCompactionEnabled ?? false} label={t("hud.actions.autoCompact")} onChange={(next) => void setAutoCompaction(tabId, next)} /></div>
              </div>
              <div className="mt-2 rounded-md border border-line px-3">
                <FastModeControl tabId={tabId} layout="sheet" />
              </div>
            </div>
          </div>
          <CompactModes tabId={tabId} autoRetry={autoRetry} onAutoRetry={updateAutoRetry} />
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
        compacting={session?.isCompacting === true || compacting}
        stallMs={streamStallMs}
        face={resolvedFace}
        label={label}
        className="shrink-0 [app-region:no-drag]"
        title={t("hud.status.rpcStatus", { status: label })}
      />
      {/* Shrinkable, clipping, still draggable (NOT no-drag, NOT flex-1): the
          status cluster clips here, so the gauge on the right is never cut
          off (#941). */}
      <div className="titlebar-status flex min-w-0 shrink items-center gap-2.5 overflow-hidden">
        {/* key: an open menu closes when the HUD switches to another tab. */}
        <TitleMenu
          key={tabId}
          tabId={tabId}
          title={title ?? t("hud.session.untitled")}
          chat={chat}
          projectCwd={projectCwd}
          instanceId={instanceId}
          compacting={session?.isCompacting === true || compacting}
          treeAvailable={treeAvailable}
          anonAvailable={anonAvailable}
          mcpFailureCount={mcpFailureCount}
          autoRetry={autoRetry}
          onAutoRetry={updateAutoRetry}
          onRefresh={refresh}
        />
        {agentModeChip}
        {instanceChip}
        {fleetChip}
        {/* Remote sessions retain the informational and finish-capable chip;
            only host-local open rows are suppressed (issue #435). */}
        {worktree && (
          <WorktreeChip
            worktree={worktree}
            tabId={tabId}
            hostLocalActions={instanceId === null}
            className="[app-region:no-drag]"
          />
        )}
        {goalChip}
        {vibeChip}
        {jobsChip}
        {autoresearchChip}
        {fastChip}
        {approvalChip}
        {/* Quota attention states stay in the row: the account-stage chip
            (issue #777) and the transient rotation/wait chip (issue #673). */}
        {usageLimitChip}
        {quotaChip}
      </div>
      <span className="min-w-0 flex-1" />
      <GaugeChip
        key={tabId}
        tabId={tabId}
        usage={usage}
        markerTokens={markerTokens}
        mainSpend={mainSpend}
        sessionSpend={sessionSpend}
        limits={limitsReady}
        advisor={showAdvisor ? advisorStats : null}
        notices={notices}
        compacting={session?.isCompacting === true || compacting}
        autoCompaction={session?.autoCompactionEnabled ?? false}
        instanceId={instanceId}
        cwd={cwd}
        rosterProjectCwd={chat ? null : projectCwd ?? null}
      />
    </div>
  );
}
