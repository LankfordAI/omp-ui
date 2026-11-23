import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { AGENT_PREWALK_AUTO_KEY } from "@omp-ui/core/omp-settings-keys";
import { useStore } from "../../store";
import { Label } from "../ui";
import { CommitField, layerBadge } from "./rows";

const EMPTY_ROSTER: string[] = [];

/** The record value of one entry, or {} when unset/not a record. */
function recordOf(value: OmpSettingValue | undefined): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * The omp page's "Judge-armed subagent prewalk" section (omp 18.22, issue
 * #1206): `task.agentPrewalkAuto`, the per-agent record that asks the native
 * judge whether each assignment of a spawned subagent should prewalk — the
 * entry is `"on"` (arm `prewalk.autoTarget`), `"off"`, or a model pattern;
 * `task.agentPrewalk` for the same agent beats this, and an entry for an
 * unknown agent is simply never consulted.
 *
 * Global layer only, like Computer control: `omp config set` REPLACES the
 * record, so every write spreads the whole global record back — ADR-0031
 * discipline, merge base `globalValue`, never the effective value, so a
 * project layer's entries are not baked into the global file. An empty draft
 * removes the agent's key. The roster rows come from the discovered agent
 * list; stored keys for agents off the roster (renamed or hand-written)
 * render below it. An older omp publishes no entry, so the section stays
 * hidden.
 */
export function AgentPrewalkAutoSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The task.agentPrewalkAuto snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const roster = useStore((s) => s.state?.agentRoster ?? EMPTY_ROSTER);
  if (entry === undefined) return null;

  const record = recordOf(entry.globalValue);
  const pendingWrite = pendingKey === AGENT_PREWALK_AUTO_KEY;

  const pick = (agent: string, raw: string): void => {
    const value = raw.trim();
    // An unchanged draft is not an edit; CommitField guarantees the draft
    // differs from `current`, so only a whitespace-collapse needs guarding.
    if (value === record[agent]) return;
    const merged: Record<string, unknown> = { ...record };
    if (value === "") delete merged[agent];
    else merged[agent] = value;
    commit(AGENT_PREWALK_AUTO_KEY, merged);
  };

  const agents = [...roster];
  for (const stored of Object.keys(record)) {
    if (!agents.includes(stored)) agents.push(stored);
  }

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>Judge-armed subagent prewalk</Label>
        {layerBadge(entry.layer)}
      </div>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
        Per-agent entries for task.agentPrewalkAuto (omp 18.22+): on asks the native judge per assignment whether to prewalk, handing off to prewalk.autoTarget at the first edit; off skips the judgment; any other text is a model pattern. A per-agent task.agentPrewalk entry or the agent's own prewalk frontmatter arms unconditionally and beats this. Empty clears the agent's entry. Edits write the global layer.
      </p>
      <div className="mt-1.5 divide-y divide-line-soft">
        {agents.map((agent) => (
          <div key={agent} className="flex items-center gap-3 py-1.5">
            <span className="w-32 shrink-0 truncate font-mono text-xs text-ink-mid" title={agent}>
              {agent}
            </span>
            <CommitField
              current={typeof record[agent] === "string" ? record[agent] : ""}
              kind="text"
              label={`prewalk entry for ${agent}`}
              placeholder="on"
              disabled={pendingWrite}
              className="w-56 font-mono"
              onCommit={(raw) => pick(agent, raw)}
            />
          </div>
        ))}
      </div>
      {agents.length === 0 && (
        <p className="mt-1.5 text-sm text-ink-faint">No agents discovered yet — focus a running session or refresh the roster from Subagent models.</p>
      )}
    </section>
  );
}
