import type { LiveState, SessionSummary } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useStore } from "../store";
import { Chip, Dot, IconButton, type Tone } from "./ui";

/** Liveness reads as colour before it reads as text — mint only when alive. */
const LIVE_TONE: Record<LiveState, Tone> = {
  live: "signal",
  dormant: "neutral",
  archived: "copper",
  missing: "rose",
};

const MISSING_HINT = "session files are gone from disk — prune the record";

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

function IconPrune() {
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

export function SessionRow({ s }: { s: SessionSummary }) {
  const openSession = useStore((st) => st.openSession);
  const switchMode = useStore((st) => st.switchMode);
  const prune = useStore((st) => st.prune);
  const activeTabId = useStore((st) => st.activeTabId);

  const missing = s.live === "missing";
  const active = s.tabId === activeTabId;
  const rpc = s.mode === "rpc-ui";
  const when = relativeTime(s.cachedModified);

  return (
    <div
      className={cn(
        "group/row animate-slide-in relative flex items-center rounded-md",
        "transition-colors duration-150",
        active ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-signal"
        />
      )}

      <button
        type="button"
        title={missing ? MISSING_HINT : s.title}
        onClick={() => {
          if (!missing) void openSession(s.tabId);
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left",
          missing && "cursor-default",
        )}
      >
        <Dot tone={LIVE_TONE[s.live]} pulse={s.live === "live"} title={s.live} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs transition-colors duration-150",
              missing ? "text-ink-faint" : "text-ink-mid group-hover/row:text-ink",
              active && !missing && "text-ink",
            )}
          >
            {s.title}
          </span>
          <span
            title={absoluteTime(s.cachedModified)}
            className="block truncate font-mono text-[10px] text-ink-faint tabular-nums"
          >
            {when}
            {when && s.status ? " · " : ""}
            {s.status ?? ""}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        <button
          type="button"
          disabled={missing}
          title={rpc ? "switch to terminal mode" : "switch to native mode"}
          onClick={() => void switchMode(s.tabId, rpc ? "pty" : "rpc-ui")}
          className={cn(
            "rounded transition-[filter,opacity] duration-150",
            "hover:brightness-125 disabled:pointer-events-none disabled:opacity-35",
          )}
        >
          <Chip mono tone={rpc ? "iris" : "neutral"}>
            {rpc ? "rpc" : "term"}
          </Chip>
        </button>
        {missing && (
          <IconButton
            label="prune the record (files on disk are kept)"
            tone="rose"
            onClick={() => void prune(s.tabId)}
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            <IconPrune />
          </IconButton>
        )}
      </div>
    </div>
  );
}
