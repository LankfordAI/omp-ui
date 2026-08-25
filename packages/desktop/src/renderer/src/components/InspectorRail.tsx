import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { useCompactShell, useViewportWidth } from "../lib/responsive";
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MIN_WIDTH,
  resolveDesktopPanelWidths,
} from "../lib/panel-layout";
import { parseBranchDiff, type DiffFile } from "../lib/omp-diff";
import { queueChipView } from "../lib/queue-chip";
import type { SessionStats, SubagentInfo, TokenTotals } from "../lib/rpc-types";
import { findRecord, sessionCwd, useStore, type PlanRecord, type RpcTabState } from "../store";
import { DiffViewer } from "./DiffViewer";
import { compactNum, exactNum, formatCost, shortBase } from "../lib/format";
import { TodoPanel } from "./TodoPanel";
import { AGENT_TONE, Button, Chip, CopyButton, Dot, Empty, ICON_STROKE, IconRefresh, IconButton, Label, ResizeHandle, Sheet, type Tone } from "./ui";

interface BranchDiffLoad {
  status: "idle" | "loading" | "error" | "loaded";
  message?: string;
  branch?: string | null;
  repoRoot?: string | null;
  files?: DiffFile[];
  mergeBase?: string | null;
}

/**
 * The right-hand instrument rail: the agent's plan, its subagents, and the
 * hard session facts. The icon strip is the permanent posture — pressing an
 * icon opens just that one pane beside it, and re-pressing the active icon
 * (or the pane's close control) dismisses it. Badge counts live on the strip
 * icons. (The console moved to the composer drawer — issue #33.)
 */

export type RailTab = "todos" | "agents" | "session" | "plans" | "diffs";

/**
 * Rail selection is per-session and deliberately module-level: it is view
 * preference, not session state, so it must not round-trip through the store —
 * but it must also survive a tab switch and back, which component state cannot.
 */
const selectedTab = new Map<string, RailTab>();
// Open posture is shared renderer view state; selected panes remain per-tab.

/* ------------------------------------------------------------------- icons */

function TabIcon({ tab }: { tab: RailTab }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      {tab === "todos" && (
        <>
          <path d="M2.5 4.2l1.4 1.4 2.3-2.4M2.5 11.2l1.4 1.4 2.3-2.4" {...ICON_STROKE} />
          <path d="M8.6 4.6h5M8.6 11.6h5" {...ICON_STROKE} />
        </>
      )}
      {tab === "agents" && (
        <>
          <circle cx="5.4" cy="5" r="2.1" {...ICON_STROKE} />
          <path d="M1.9 13c0-2.1 1.6-3.5 3.5-3.5S8.9 10.9 8.9 13" {...ICON_STROKE} />
          <circle cx="11.6" cy="6.4" r="1.6" {...ICON_STROKE} />
          <path d="M9.9 12.6c0-1.7 1-2.7 2.3-2.7 1 0 1.9.6 2.2 1.7" {...ICON_STROKE} />
        </>
      )}
      {tab === "session" && (
        <>
          <path d="M2.6 4.4c0-1 2.4-1.9 5.4-1.9s5.4.9 5.4 1.9-2.4 1.9-5.4 1.9S2.6 5.4 2.6 4.4z" {...ICON_STROKE} />
          <path d="M2.6 4.4v7.2c0 1 2.4 1.9 5.4 1.9s5.4-.9 5.4-1.9V4.4" {...ICON_STROKE} />
          <path d="M2.6 8c0 1 2.4 1.9 5.4 1.9s5.4-.9 5.4-1.9" {...ICON_STROKE} />
        </>
      )}
      {tab === "plans" && (
        <>
          <path d="M3.4 5.6h9.2V12a1.3 1.3 0 0 1-1.3 1.3H4.7A1.3 1.3 0 0 1 3.4 12z" {...ICON_STROKE} />
          <path d="M5.2 3h5.6v2.6H5.2z" {...ICON_STROKE} />
          <path d="M6.3 9.1l1.3 1.3 2.1-2.6" {...ICON_STROKE} />
        </>
      )}
      {tab === "diffs" && (
        <>
          <path d="M2.8 4.4h8.6v6.6a1.2 1.2 0 0 1-1.2 1.2H4A1.2 1.2 0 0 1 2.8 11z" {...ICON_STROKE} />
          <path d="M12.4 3.4v4.6M10.1 5.7h4.6" {...ICON_STROKE} />
          <path d="M6 2H4.4A1.4 1.4 0 0 0 3 3.4v1.8M10 14h1.6a1.4 1.4 0 0 0 1.4-1.4v-1.8" {...ICON_STROKE} />
        </>
      )}
    </svg>
  );
}

function IconCollapse() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 rotate-180">
      <path d="M10 4l-3.5 4 3.5 4" {...ICON_STROKE} />
      <path d="M3.5 2.6v10.8" {...ICON_STROKE} />
    </svg>
  );
}

/* ------------------------------------------------------------------ shared */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <dt className="w-[6.5rem] shrink-0 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[11px] text-ink-mid">{children}</dd>
    </div>
  );
}

function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="block truncate font-mono text-[11px] tabular-nums text-ink-mid">
      {children}
    </span>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <Label className="min-w-0 flex-1 truncate">{title}</Label>
        {action}
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- the panes */

function AgentsPane({ tabId }: { tabId: string }) {
  const subagents = useStore((s) => s.rpc[tabId]?.subagents) ?? [];
  const buffers = useStore((s) => s.rpc[tabId]?.subagentItems) ?? {};
  const selected = useStore((s) => s.rpc[tabId]?.selectedSubagent) ?? null;
  const openSubagent = useStore((s) => s.openSubagent);
  const closeSubagent = useStore((s) => s.closeSubagent);
  const refreshSubagents = useStore((s) => s.refreshSubagents);

  // The roster is the live list UNION agents whose buffers outlived them:
  // settled agents stay visible (dimmed) until the session resets.
  // Selecting a row opens the subagent view in the main pane; re-clicking
  // the selected row returns to the main agent.
  const liveIds = new Set(subagents.map((a) => a.id));
  const retained: SubagentInfo[] = Object.keys(buffers)
    .filter((key) => !liveIds.has(key))
    .map((key) => ({ id: key, status: "settled" }));
  const roster = [...subagents, ...retained];

  return (
    <Section
      title={`subagents · ${roster.length}`}
      action={
        <IconButton label="refresh subagents" onClick={() => void refreshSubagents(tabId)}>
          <IconRefresh />
        </IconButton>
      }
    >
      {roster.length === 0 ? (
        <Empty
          title="No subagents"
          hint="Delegated agents appear here while they run."
          action={
            <Button size="xs" onClick={() => void refreshSubagents(tabId)}>
              refresh
            </Button>
          }
        />
      ) : (
        <ul className="space-y-1">
          {roster.map((agent) => {
            const status = agent.status ?? "unknown";
            const settled = !liveIds.has(agent.id);
            return (
              <li key={agent.id} className="animate-slide-in">
                <button
                  type="button"
                  aria-label={`${selected === agent.id ? "close" : "open"} agent ${agent.name ?? agent.agent ?? agent.id}`}
                  aria-pressed={selected === agent.id}
                  onClick={() =>
                    selected === agent.id
                      ? closeSubagent(tabId)
                      : openSubagent(tabId, agent.id)
                  }
                  className={cn(
                    "w-full rounded-md border border-line bg-raised px-2 py-1.5 text-left transition-colors hover:bg-hover",
                    settled && "opacity-50",
                    selected === agent.id && "bg-hover",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Dot
                      tone={AGENT_TONE[status] ?? "neutral"}
                      pulse={AGENT_TONE[status] === "copper"}
                      title={status}
                    />
                    <span className="min-w-0 flex-1 truncate font-display text-[12px] text-ink">
                      {agent.name ?? agent.agent ?? agent.id}
                    </span>
                    {agent.agent && agent.name && (
                      <Chip mono title={`agent type: ${agent.agent}`}>
                        {agent.agent}
                      </Chip>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5 pl-3">
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">{status}</span>
                    {agent.label && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim" title={agent.label}>
                        {agent.label}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

const TOKEN_ROWS: { key: keyof TokenTotals; label: string }[] = [
  { key: "input", label: "input" },
  { key: "output", label: "output" },
  { key: "reasoning", label: "reasoning" },
  { key: "cacheRead", label: "cache read" },
  { key: "cacheWrite", label: "cache write" },
  { key: "total", label: "total" },
];

function StatsTable({ stats }: { stats: SessionStats }) {
  return (
    <>
      <Section title="messages">
        <dl>
          <Row label="user">
            <Mono>{exactNum(stats.userMessages)}</Mono>
          </Row>
          <Row label="assistant">
            <Mono>{exactNum(stats.assistantMessages)}</Mono>
          </Row>
          <Row label="tool calls">
            <Mono>{exactNum(stats.toolCalls)}</Mono>
          </Row>
          <Row label="tool results">
            <Mono>{exactNum(stats.toolResults)}</Mono>
          </Row>
          <Row label="total">
            <Mono>{exactNum(stats.totalMessages)}</Mono>
          </Row>
        </dl>
      </Section>
      <Section title="tokens">
        <table className="w-full">
          <tbody>
            {TOKEN_ROWS.map(({ key, label }) => (
              <tr key={key} className={key === "total" ? "border-t border-line-soft" : undefined}>
                <td className="py-0.5 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  {label}
                </td>
                <td
                  title={exactNum(stats.tokens[key])}
                  className={cn(
                    "py-0.5 text-right font-mono text-[11px] tabular-nums",
                    key === "total" ? "text-ink" : "text-ink-mid",
                  )}
                >
                  {compactNum(stats.tokens[key])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="spend">
        <dl>
          <Row label="cost">
            <Mono title={`${stats.cost}`}>{formatCost(stats.cost)}</Mono>
          </Row>
          <Row label="premium reqs">
            <Mono>{exactNum(stats.premiumRequests)}</Mono>
          </Row>
        </dl>
      </Section>
    </>
  );
}

function SessionPane({ tabId }: { tabId: string }) {
  const session = useStore((s) => s.rpc[tabId]?.session);
  const stats = useStore((s) => s.rpc[tabId]?.stats);
  const model = useStore((s) => s.rpc[tabId]?.model);
  const status = useStore((s) => s.rpc[tabId]?.status);
  const queueChip = queueChipView(status === "running", session?.queuedMessageCount ?? 0);
  const refreshState = useStore((s) => s.refreshState);
  const refreshStats = useStore((s) => s.refreshStats);

  return (
    <>
      <Section
        title="session"
        action={
          <IconButton
            label="refresh state and stats"
            onClick={() => {
              void refreshState(tabId);
              void refreshStats(tabId);
            }}
          >
            <IconRefresh />
          </IconButton>
        }
      >
        <dl>
          <Row label="id">
            <span className="flex items-center gap-1">
              <Mono title={session?.sessionId ?? undefined}>{session?.sessionId ?? "—"}</Mono>
              {session?.sessionId && <CopyButton text={session.sessionId} label="id" />}
            </span>
          </Row>
          <Row label="file">
            <span className="flex items-center gap-1">
              <Mono title={session?.sessionFile ?? undefined}>{session?.sessionFile ?? "—"}</Mono>
              {session?.sessionFile && <CopyButton text={session.sessionFile} label="path" />}
            </span>
          </Row>
          <Row label="messages">
            <Mono>{session ? exactNum(session.messageCount) : "—"}</Mono>
          </Row>
          <Row label="queued">
            <Mono title={queueChip?.title}>
              {session
                ? `${exactNum(session.queuedMessageCount)}${
                    queueChip && status !== "running" ? " (parked)" : ""
                  }`
                : "—"}
            </Mono>
          </Row>
        </dl>
      </Section>

      <Section title="model">
        <dl>
          <Row label="model">
            <span className="block truncate" title={model?.id}>
              {model?.name ?? model?.id ?? "—"}
            </span>
          </Row>
          <Row label="provider">
            <Mono>{model?.provider ?? "—"}</Mono>
          </Row>
          <Row label="thinking">
            <Mono>{session?.thinkingLevel ?? "—"}</Mono>
          </Row>
          <Row label="context">
            <Mono>{model?.contextWindow ? compactNum(model.contextWindow) : "—"}</Mono>
          </Row>
        </dl>
      </Section>

      <Section title="queue">
        <dl>
          <Row label="steering">
            <Mono>{session?.steeringMode ?? "—"}</Mono>
          </Row>
          <Row label="follow-up">
            <Mono>{session?.followUpMode ?? "—"}</Mono>
          </Row>
          <Row label="interrupt">
            <Mono>{session?.interruptMode ?? "—"}</Mono>
          </Row>
          <Row label="auto-compact">
            <Chip tone={session?.autoCompactionEnabled ? "signal" : "neutral"}>
              {session?.autoCompactionEnabled ? "on" : "off"}
            </Chip>
          </Row>
        </dl>
      </Section>

      {stats ? (
        <StatsTable stats={stats} />
      ) : (
        <Section title="stats">
          <Empty
            title="No stats yet"
            hint="Refresh to pull the session's token and cost breakdown."
            action={
              <Button size="xs" onClick={() => void refreshStats(tabId)}>
                refresh stats
              </Button>
            }
          />
        </Section>
      )}
    </>
  );
}

/* -------------------------------------------------- plans + branch diffs */

const PLAN_TONE: Record<PlanRecord["status"], Tone> = {
  pending: "copper",
  executed: "signal",
  refined: "neutral",
};
const PLAN_LABEL: Record<PlanRecord["status"], string> = {
  pending: "waiting on you",
  executed: "executed",
  refined: "sent back",
};

/**
 * This session's proposed plans. The pending plan — the one omp's agent is
 * blocked on — is actionable: review re-opens the modal, request changes sends
 * the planner back to revise, and "not now" leaves it pending until later.
 * Settled plans stay as a dim record of the session's plan history.
 */
function PlansPane({ tabId }: { tabId: string }) {
  const records = useStore((s) => s.rpc[tabId]?.plans) ?? [];
  const reviewPath = useStore((s) => s.rpc[tabId]?.planReview?.request.planFilePath);
  const deferred = useStore((s) => s.rpc[tabId]?.planDeferred === true);
  const showPlanReview = useStore((s) => s.showPlanReview);
  const deferPlanReview = useStore((s) => s.deferPlanReview);
  const refinePlan = useStore((s) => s.refinePlan);

  if (records.length === 0) {
    return (
      <Empty
        title="No proposed plans"
        hint="A plan-mode draft appears here once the agent writes it up."
      />
    );
  }

  return (
    <div className="space-y-2 px-3 py-2.5">
      {records.map((record) => {
        const actionable = record.status === "pending" && record.key === reviewPath;
        return (
          <div key={record.key} className="overflow-hidden rounded-md border border-line bg-raised">
            <button
              type="button"
              disabled={!actionable}
              title={actionable ? "open the plan review" : record.title}
              onClick={() => showPlanReview(tabId)}
              className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left disabled:hover:bg-transparent enabled:hover:bg-hover"
            >
              <Dot
                tone={PLAN_TONE[record.status]}
                title={PLAN_LABEL[record.status]}
                className="mt-1"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">
                  {record.title}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  <Chip mono tone={PLAN_TONE[record.status]}>
                    {PLAN_LABEL[record.status]}
                  </Chip>
                  {actionable && deferred && (
                    <span className="text-[10px] text-ink-faint">paused · not now</span>
                  )}
                </span>
              </span>
            </button>
            {actionable && (
              <div className="flex items-center gap-1 border-t border-line-soft bg-sunken px-2 py-1.5">
                <Button size="xs" onClick={() => showPlanReview(tabId)}>
                  review
                </Button>
                <Button
                  size="xs"
                  title="Send the agent back to revise the draft"
                  onClick={() => refinePlan(tabId)}
                >
                  request changes
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  title="Leave the plan pending — the agent stays paused until you answer elsewhere"
                  onClick={() => deferPlanReview(tabId)}
                >
                  not now
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * All working-tree changes on this project's active git branch: tracked
 * `git diff HEAD` plus new untracked files, one DiffViewer per file. Loads on
 * pane mount and on demand; not a git repository renders an empty state.
 */
function DiffsPane({ tabId }: { tabId: string }) {
  const record = useStore((s) => findRecord(s.state, tabId));
  const cwd = sessionCwd(record);
  const base = record?.worktree?.base ?? null;
  // A checkout through the composer chip (issue #35) updates this slice; the
  // pane re-reads so it never shows the previous branch's diff.
  const currentBranch = useStore((s) => (cwd ? s.branches[cwd]?.current : undefined));
  const branchDiffRevision = useStore((s) => (cwd ? (s.branchDiffRevision[cwd] ?? 0) : 0));
  const [load, setLoad] = useState<BranchDiffLoad>({ status: "idle" });
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!cwd) {
      setLoad({ status: "loaded", repoRoot: null, branch: null, files: [], mergeBase: null });
      return;
    }
    if (requestId === requestIdRef.current) setLoad({ status: "loading" });
    try {
      const branch = await backend.getBranchDiff(cwd, base);
      if (requestId !== requestIdRef.current) return;
      setLoad({
        status: "loaded",
        branch: branch.branch,
        repoRoot: branch.repoRoot,
        mergeBase: branch.mergeBase,
        files: parseBranchDiff(branch.diff, branch.untracked),
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setLoad({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [cwd, base]);

  useEffect(() => {
    void refresh();
  }, [refresh, currentBranch, branchDiffRevision]);

  if (load.status === "idle" || load.status === "loading") {
    return <Empty title="Reading branch…" hint="Gathering the working-tree diff." />;
  }
  if (load.status === "error") {
    return (
      <Empty
        title="Could not read the diff"
        hint={load.message}
        action={
          <Button size="xs" onClick={() => void refresh()}>
            retry
          </Button>
        }
      />
    );
  }
  if (!load.repoRoot) {
    return (
      <Empty
        title="No git repository"
        hint="This project isn't inside a git repo, so there's no branch to diff."
      />
    );
  }
  const files = load.files ?? [];
  if (files.length === 0) {
    return (
      <Empty
        title="Working tree clean"
        hint={
          load.mergeBase != null && base !== null
            ? `No changes on ${load.branch ?? "this branch"} since ${shortBase(base)}.`
            : `No changes on ${load.branch ?? "this branch"} since HEAD.`
        }
      />
    );
  }
  return (
    <div>
      <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-2">
        {/* Branch identity is chrome, not liveness — neutral, never signal
            (ADR-0004). */}
        <Chip mono title={load.repoRoot ?? undefined}>
          {load.branch ?? "detached"}
        </Chip>
        {load.mergeBase != null && base !== null && (
          <Chip mono title={load.mergeBase}>
            since {shortBase(base)}
          </Chip>
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint"
          title={load.repoRoot ?? undefined}
        >
          {load.repoRoot}
        </span>
        <IconButton label="refresh branch diff" onClick={() => void refresh()}>
          <IconRefresh />
        </IconButton>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {files.map((file) => (
          <DiffViewer key={file.path} rows={file.rows} path={file.path} op={file.op} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- the rail */

const TABS: { id: RailTab; label: string }[] = [
  { id: "todos", label: "todos" },
  { id: "agents", label: "agents" },
  { id: "session", label: "session" },
  { id: "plans", label: "plans" },
  { id: "diffs", label: "diffs" },
];

export function inspectorBadges(runtime: RpcTabState | undefined): Record<RailTab, number> {
  let openTodos = 0;
  for (const phase of runtime?.todos ?? []) {
    for (const task of phase.tasks ?? []) if (task.status !== "completed") openTodos += 1;
  }
  return {
    todos: openTodos,
    agents: runtime?.subagents.length ?? 0,
    session: 0,
    plans: runtime?.planReview ? 1 : 0,
    diffs: 0,
  };
}

export function InspectorRail({ tabId }: { tabId: string }) {
  const [tab, setTab] = useState<RailTab>(() => selectedTab.get(tabId) ?? "todos");
  const compact = useCompactShell();
  const viewportWidth = useViewportWidth();
  const surface = useStore((s) => s.compactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const runtime = useStore((s) => s.rpc[tabId]);
  const open = useStore((s) => s.inspectorOpen);
  const setOpen = useStore((s) => s.setInspectorOpen);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const setInspectorWidth = useStore((s) => s.setInspectorWidth);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  const lastTabId = useRef(tabId);
  if (lastTabId.current !== tabId) {
    lastTabId.current = tabId;
    setTab(selectedTab.get(tabId) ?? "todos");
  }


  useEffect(() => {
    setPreviewWidth(null);
  }, [inspectorWidth]);

  const resolvedWidths = resolveDesktopPanelWidths({
    viewportWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed,
    inspectorOpen: open,
  });
  const displayedInspectorWidth = previewWidth ?? resolvedWidths.inspectorWidth;
  const badges = inspectorBadges(runtime);
  const close = (): void => {
    setOpen(false);
  };
  const select = (next: RailTab): void => {
    // Re-pressing the active icon dismisses the pane back to the strip.
    if (!compact && next === tab && open) {
      close();
      return;
    }
    selectedTab.set(tabId, next);
    setTab(next);
    if (!compact && !open) {
      setOpen(true);
    }
  };
  const pane = (
    <>
      {tab === "todos" && <TodoPanel tabId={tabId} />}
      {tab === "agents" && <AgentsPane tabId={tabId} />}
      {tab === "session" && <SessionPane tabId={tabId} />}
      {tab === "plans" && <PlansPane tabId={tabId} />}
      {tab === "diffs" && <DiffsPane tabId={tabId} />}
    </>
  );

  if (compact) {
    return (
      <Sheet open={surface === "inspector"} placement="right" label="inspector" onClose={closeCompactSurface}>
        <div className="sticky top-0 z-10 grid grid-cols-5 border-b border-line bg-sunken">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-pressed={id === tab}
              onClick={() => select(id)}
              className={cn(
                "relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors",
                id === tab ? "bg-raised text-ink" : "text-ink-dim",
              )}
            >
              <TabIcon tab={id} />
              <span>{label}</span>
              {badges[id] > 0 && <span className="absolute right-1.5 top-1 min-w-3.5 rounded-full bg-copper-wash px-1 text-center font-mono text-[9px] leading-3.5 text-copper">{badges[id] > 99 ? "99+" : badges[id]}</span>}
              {id === tab && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ink" />}
            </button>
          ))}
        </div>
        <div>{pane}</div>
      </Sheet>
    );
  }

  // Desktop: the strip is always the rail; at most one pane opens beside it.
  return (
    <aside className="ambient flex shrink-0 bg-sunken">
      {open && (
        <div
          className={cn(
            "relative flex shrink-0 flex-col border-l border-line",
            !resizing && "transition-[width] duration-200 ease-out-quint",
          )}
          style={{ width: displayedInspectorWidth }}
        >
          <ResizeHandle
            label="resize inspector"
            edge="left"
            value={displayedInspectorWidth}
            min={INSPECTOR_MIN_WIDTH}
            max={resolvedWidths.inspectorAllowedMax}
            defaultValue={INSPECTOR_DEFAULT_WIDTH}
            onPreview={setPreviewWidth}
            onCommit={(width) => {
              setInspectorWidth(width);
              setPreviewWidth(null);
            }}
            onDraggingChange={setResizing}
          />
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2.5">
            <Label className="min-w-0 flex-1 truncate">{tab}</Label>
            <IconButton label="collapse inspector" onClick={close}>
              <IconCollapse />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{pane}</div>
        </div>
      )}
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-line py-2">
        {TABS.map(({ id, label }) => (
          <button key={id} type="button" title={badges[id] > 0 ? `${label} (${badges[id]})` : label} aria-label={label} aria-pressed={open && id === tab} onClick={() => select(id)} className={cn("relative grid size-7 place-items-center rounded-md transition-colors", open && id === tab ? "bg-raised text-ink" : "text-ink-dim hover:bg-hover hover:text-ink-mid")}>
            <TabIcon tab={id} />
            {badges[id] > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-copper-wash px-0.5 text-center font-mono text-[9px] leading-3 text-copper">{badges[id] > 99 ? "99" : badges[id]}</span>}
          </button>
        ))}
      </div>
    </aside>
  );
}
