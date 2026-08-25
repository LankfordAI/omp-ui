import { AGENT_TONE } from "../lib/agent-tone";
import type { RenderItem } from "../lib/transcript";
import { useStore } from "../store";
import { TranscriptView } from "./TranscriptView";
import { Chip, Dot } from "./ui";

const NO_ITEMS: RenderItem[] = [];

/**
 * The subagent view: the rpc-ui tab's main pane while a subagent is
 * selected in the Agents pane. The full transcript surface — tool cards,
 * thinking, usage receipts — rendered read-only from the agent's buffer
 * (backfilled on open from its transcript file), under a banner naming the
 * agent and leading back to the main agent. No composer: a subagent cannot
 * be prompted or steered. A settled agent keeps its retained buffer — the
 * view stays open on it until the session resets.
 */
export function SubagentView({
  tabId,
  agentKey,
}: {
  tabId: string;
  agentKey: string;
}) {
  const subagents = useStore((s) => s.rpc[tabId]?.subagents) ?? [];
  const items = useStore((s) => s.rpc[tabId]?.subagentItems?.[agentKey]) ?? NO_ITEMS;
  const closeSubagent = useStore((s) => s.closeSubagent);
  const live = subagents.find((a) => a.id === agentKey);
  const name = live?.name ?? live?.agent ?? agentKey;
  const status = live?.status ?? "settled";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2">
        <button
          type="button"
          aria-label="back to main agent"
          onClick={() => closeSubagent(tabId)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:bg-hover hover:text-ink-mid"
        >
          ‹ main agent
        </button>
        <Dot
          tone={AGENT_TONE[status] ?? "neutral"}
          pulse={AGENT_TONE[status] === "copper"}
          title={status}
        />
        <span
          className="min-w-0 truncate font-display text-[13px] text-ink"
          title={name}
        >
          {name}
        </span>
        {live?.agent && live.name && (
          <Chip mono title={`agent type: ${live.agent}`}>
            {live.agent}
          </Chip>
        )}
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          {status}
        </span>
        {live?.label && (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
            title={live.label}
          >
            {live.label}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          read-only subagent view
        </span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-[11px] text-ink-faint">
          No activity captured yet — the transcript fills in as the agent works.
        </p>
      ) : (
        <TranscriptView items={items} />
      )}
    </div>
  );
}
