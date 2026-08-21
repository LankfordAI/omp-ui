import type { PlanImplementationSource, SessionSummary } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { deriveSidebarSessionState, useStore, type SidebarSessionState } from "../store";
import { Button, Dot, IconButton, type Tone } from "./ui";

const MISSING_HINT = "session files are gone from disk — delete the record";

const SESSION_FACE: Record<
  SidebarSessionState,
  { tone: Tone; pulse: boolean; label: string; title: string; textClass: string }
> = {
  working: {
    tone: "copper",
    pulse: true,
    label: "working",
    title: "Agent is working",
    textClass: "text-copper",
  },
  "awaiting-answer": {
    tone: "iris",
    pulse: false,
    label: "answer needed",
    title: "Agent is waiting for your answer",
    textClass: "text-iris",
  },
  stalled: {
    tone: "copper",
    pulse: false,
    label: "stalled",
    title: "omp-ui aborted a turn whose model stream went silently dead — send a prompt to continue",
    textClass: "text-copper",
  },
  ready: {
    tone: "signal",
    pulse: false,
    label: "ready",
    title: "Agent finished output and is ready",
    textClass: "text-signal",
  },
  starting: {
    tone: "neutral",
    pulse: true,
    label: "starting",
    title: "Native session is starting",
    textClass: "text-ink-mid",
  },
  error: {
    tone: "rose",
    pulse: false,
    label: "error",
    title: "Native session hit an error",
    textClass: "text-rose",
  },
  live: {
    tone: "signal",
    pulse: false,
    label: "live",
    title: "Session process is live; detailed activity is unavailable",
    textClass: "text-signal",
  },
  dormant: {
    tone: "neutral",
    pulse: false,
    label: "dormant",
    title: "Session is dormant",
    textClass: "text-ink-mid",
  },
  archived: {
    tone: "copper",
    pulse: false,
    label: "archived",
    title: "Session is archived",
    textClass: "text-copper",
  },
  missing: {
    tone: "rose",
    pulse: false,
    label: "missing",
    title: MISSING_HINT,
    textClass: "text-rose",
  },
};


/**
 * Coarse relative time. A sidebar row is scanned, not read: minutes and hours
 * matter, anything past a week is just a date.
 */
export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString([], { month: "short", day: "numeric" });
}

function absoluteTime(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const d = new Date(then);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function IconTrash() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 5h10M6.5 5V3.5h3V5M4.5 5l.6 7.5h5.8L11.5 5M6.8 7.3v3M9.2 7.3v3" />
    </svg>
  );
}

function IconPower() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M8 2V7.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <path
        d="M4.6 4.6a4.8 4.8 0 106.8 0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A small plan document — the row's link back to the planning session (issue #238). */
function IconPlan() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M6 7.5h4M6 10h4" />
    </svg>
  );
}

/**
 * Plan-handoff view of one sidebar row, derived by the sidebar arrangement
 * (issue #238). Exactly one of `source`/`orphanSource` is set on an
 * implementation row; a plain row carries neither.
 */
export interface SessionRowHandoff {
  /** The planning session this row implements, when it still exists. */
  source: SessionSummary | null;
  /** Saved dispatch metadata when the planning session is gone. */
  orphanSource: PlanImplementationSource | null;
  /** This row dispatched at least one implementation shown beneath it. */
  hasDescendants: boolean;
}

export function SessionRow({
  s,
  onActivate,
  handoff,
}: {
  s: SessionSummary;
  onActivate?: () => void;
  handoff?: SessionRowHandoff;
}) {
  const openSession = useStore((st) => st.openSession);
  const deleteSession = useStore((st) => st.deleteSession);
  const terminate = useStore((st) => st.terminate);
  const resumeDead = useStore((st) => st.resumeDead);
  const exited = useStore((st) => st.exited[s.tabId]);
  const sidebarState = useStore((st) =>
    deriveSidebarSessionState(s, st.rpc[s.tabId], st.exited[s.tabId]),
  );
  const activeTabId = useStore((st) => st.activeTabId);

  const missing = s.live === "missing";
  const selected = s.tabId === activeTabId;
  const rpc = s.mode === "rpc-ui";
  const when = relativeTime(s.cachedModified);
  const face = SESSION_FACE[sidebarState];
  const showPersistedStatus = !(s.live === "live" && rpc);

  // Plan handoff (issue #238). The dispatch snapshot lives on the row's own
  // record; the arrangement resolves it to a live source or an orphan marker.
  // The saved local:// plan path is deliberately never rendered.
  const source = handoff?.source ?? null;
  const orphanSource = handoff?.orphanSource ?? null;
  const planTitle = (orphanSource ?? s.planImplementationSource)?.planTitle ?? null;
  const implementsNote =
    source !== null && planTitle !== null
      ? `Implements “${planTitle}” from ${source.title}`
      : orphanSource !== null
        ? `Implements “${orphanSource.planTitle}” — source unavailable`
        : null;

  return (
    <div
      className={cn(
        "group/row animate-slide-in relative flex items-center rounded-md",
        "transition-colors duration-150",
        selected ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-signal"
        />
      )}

      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        title={
          missing ? MISSING_HINT : implementsNote !== null ? `${s.title} — ${implementsNote}` : s.title
        }
        onClick={() => {
          if (missing) return;
          void openSession(s.tabId);
          onActivate?.();
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left",
          missing && "cursor-default",
        )}
      >
        <Dot tone={face.tone} pulse={face.pulse} title={face.title} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs transition-colors duration-150",
              missing ? "text-ink-faint" : "text-ink-mid group-hover/row:text-ink",
              selected && !missing && "text-ink",
            )}
          >
            {s.title}
          </span>
          <span
            title={absoluteTime(s.cachedModified)}
            className="block truncate font-mono text-[10px] text-ink-faint tabular-nums"
          >
            <span className={face.textClass}>{face.label}</span>
            {when ? ` · ${when}` : ""}
            {showPersistedStatus && s.status ? ` · ${s.status}` : ""}
            {s.worktree ? (
              <span title={s.worktree.path}>{` · ⎇ ${s.worktree.branch}`}</span>
            ) : null}
            {source !== null
              ? " · implementation"
              : orphanSource !== null
                ? " · implementation · source unavailable"
                : ""}
            {handoff?.hasDescendants ? " · plan source" : ""}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        {source !== null && (
          <IconButton
            label="open planning session"
            onClick={() => void openSession(source.tabId)}
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            <IconPlan />
          </IconButton>
        )}
        {!missing && s.live === "live" ? (
          <IconButton
            label="stop the agent (session stays resumable)"
            tone="copper"
            onClick={() => void terminate(s.tabId)}
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            <IconPower />
          </IconButton>
        ) : !missing && exited !== undefined ? (
          <Button
            size="xs"
            tone="signal"
            variant="outline"
            onClick={() => void resumeDead(s.tabId)}
            title={`resume ${s.title}`}
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            resume
          </Button>
        ) : null}
        <IconButton
          label={
            s.live === "live"
              ? "stop the agent and delete this session"
              : missing
                ? "delete this session's record"
                : "delete session and its files"
          }
          tone="rose"
          onClick={() => void deleteSession(s.tabId)}
          className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <IconTrash />
        </IconButton>
      </div>
    </div>
  );
}
