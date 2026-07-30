import type { SessionMode } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useHotkeys } from "../lib/hotkeys";
import { findRecord, useStore } from "../store";
import { openPalette } from "./CommandPalette";
import { Button, Chip, Dot, IconButton, type Tone } from "./ui";

/* --------------------------------------------------------------------- icons */

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3">
      <path
        d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path
        d="M8 2V7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path
        d="M8 3.5V12.5M3.5 8H12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ----------------------------------------------------------------------- tab */

/** One tone answers "is this agent alive, working, or gone?" at a glance. */
function statusTone(
  status: string | undefined,
  dead: boolean,
): { tone: Tone; pulse: boolean; label: string } {
  if (dead) return { tone: "rose", pulse: false, label: "agent exited" };
  switch (status) {
    case "running":
      return { tone: "copper", pulse: true, label: "agent is working" };
    case "error":
      return { tone: "rose", pulse: false, label: "rpc error" };
    case "starting":
      return { tone: "neutral", pulse: false, label: "starting" };
    // pty tabs never populate `rpc`, so absence means "running, unobserved" —
    // not "starting", which would leave every terminal tab grey forever.
    default:
      return { tone: "signal", pulse: false, label: "agent is live" };
  }
}

function Tab({ tabId, mode, active }: { tabId: string; mode: SessionMode; active: boolean }) {
  const title = useStore((s) => findRecord(s.state, tabId)?.title);
  const status = useStore((s) => s.rpc[tabId]?.status);
  const exitCode = useStore((s) => s.exited[tabId]);
  const focusTab = useStore((s) => s.focusTab);
  const hideTab = useStore((s) => s.hideTab);
  const terminate = useStore((s) => s.terminate);
  const switchMode = useStore((s) => s.switchMode);
  const resumeDead = useStore((s) => s.resumeDead);

  const dead = exitCode !== undefined;
  const live = statusTone(status, dead);

  return (
    <div
      className={cn(
        // The active tab must read as the top edge of the pane below it, so it
        // shares the pane's plane and deliberately has no bottom border.
        "group relative flex h-9 shrink-0 items-center gap-1.5 rounded-t-md px-3",
        "text-xs transition-colors duration-150",
        // A dead tab carries two extra controls; at max-w-56 they squeeze the
        // title to nothing, so that state gets the room it actually needs.
        dead ? "max-w-80" : "max-w-56",
        active ? "bg-surface text-ink" : "text-ink-dim hover:bg-hover",
      )}
    >
      {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-signal" />}
      <Dot tone={live.tone} pulse={live.pulse} title={live.label} />
      <button
        type="button"
        // The floor keeps a few legible characters instead of collapsing to 0.
        className="min-w-14 flex-1 truncate text-left"
        title={title}
        onClick={() => focusTab(tabId)}
      >
        {title ?? "New session"}
      </button>
      <button
        type="button"
        className="shrink-0"
        onClick={() => void switchMode(tabId, mode === "pty" ? "rpc-ui" : "pty")}
      >
        <Chip
          mono
          tone={mode === "rpc-ui" ? "iris" : "neutral"}
          title="switch mode"
          className="hover:brightness-125"
        >
          {mode === "pty" ? "term" : "rpc"}
        </Chip>
      </button>
      {dead ? (
        <>
          <Chip tone="rose" mono>
            exited ({exitCode})
          </Chip>
          <Button
            size="xs"
            tone="signal"
            variant="outline"
            onClick={() => void resumeDead(tabId)}
          >
            resume
          </Button>
        </>
      ) : (
        <IconButton
          tone="copper"
          label="terminate the agent (session stays resumable)"
          className={cn("opacity-0 group-hover:opacity-100", active && "opacity-100")}
          onClick={() => void terminate(tabId)}
        >
          <PowerIcon />
        </IconButton>
      )}
      <IconButton
        label="hide tab (keeps running)"
        className={cn("opacity-0 group-hover:opacity-100", active && "opacity-100")}
        onClick={() => hideTab(tabId)}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}

/* -------------------------------------------------------------------- TabBar */

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const focusTab = useStore((s) => s.focusTab);
  const hideTab = useStore((s) => s.hideTab);

  const visible = tabs.filter((t) => !t.hidden);

  const step = (delta: number): void => {
    if (visible.length === 0) return;
    const from = visible.findIndex((t) => t.tabId === activeTabId);
    const next = visible[(Math.max(from, 0) + delta + visible.length) % visible.length];
    if (next) focusTab(next.tabId);
  };

  const nth = (i: number) => (e: KeyboardEvent) => {
    e.preventDefault();
    const target = visible[i];
    if (target) focusTab(target.tabId);
  };

  useHotkeys({
    "mod+w": (e) => {
      e.preventDefault();
      if (activeTabId !== null) hideTab(activeTabId);
    },
    "mod+shift+]": (e) => {
      e.preventDefault();
      step(1);
    },
    "mod+shift+[": (e) => {
      e.preventDefault();
      step(-1);
    },
    "mod+1": nth(0),
    "mod+2": nth(1),
    "mod+3": nth(2),
    "mod+4": nth(3),
    "mod+5": nth(4),
    "mod+6": nth(5),
    "mod+7": nth(6),
    "mod+8": nth(7),
    "mod+9": nth(8),
  });

  if (visible.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-line bg-sunken px-1.5">
      {visible.map((t) => (
        <Tab key={t.tabId} tabId={t.tabId} mode={t.mode} active={t.tabId === activeTabId} />
      ))}
      <div className="flex shrink-0 items-center pl-1">
        <IconButton label="new session" onClick={() => openPalette("New session")}>
          <PlusIcon />
        </IconButton>
      </div>
    </div>
  );
}
