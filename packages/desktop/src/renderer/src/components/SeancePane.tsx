import { useState, type FormEvent } from "react";
import { AGENT_TONE } from "../lib/agent-tone";
import { useT } from "../lib/i18n";
import type { SubagentInfo } from "../lib/rpc-types";
import { SEANCE_MIN_OMP, supportsSeance } from "../lib/seance";
import { useStore } from "../store";
import { subagentControllable } from "./SubagentControls";
import { Button, Dot, Empty } from "./ui";

/**
 * The Seance pane of the Inspector rail (issue #885): this session's Seance
 * consults — read-only consultations of a saved Session through omp's bundled
 * `seance` task agent. The subagent roster filtered by that agent identity is
 * the truth (omp's hub persists it); this pane only launches, follows up on a
 * running consultant, and opens its transcript. A controllable row steers its
 * follow-up through the shared subagent verb; a settled row cannot be steered
 * — the consultant's context died with its run — so it offers a fresh consult
 * instead. Below the version floor the pane states the requirement and
 * dispatches nothing.
 */

/** The inline follow-up input: the SideQuestionsPane AskBox shape on steering duty. */
function FollowUpBox({
  placeholder,
  buttonLabel,
  disabled,
  onSubmit,
}: {
  placeholder: string;
  buttonLabel: string;
  disabled: boolean;
  onSubmit: (question: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const question = draft.trim();
    if (disabled || question === "") return;
    onSubmit(question);
    setDraft("");
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-50"
      />
      <Button type="submit" size="xs" variant="outline" disabled={disabled || draft.trim() === ""}>
        {buttonLabel}
      </Button>
    </form>
  );
}

function ConsultCard({
  agent,
  selected,
  busy,
  onToggle,
  onFollowUp,
  onAskAgain,
}: {
  agent: SubagentInfo;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onFollowUp: (question: string) => void;
  onAskAgain: () => void;
}) {
  const t = useT();
  const status = agent.status ?? "unknown";
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-raised px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={t("rail.seance.openTranscript")}
          aria-pressed={selected}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline"
        >
          <Dot
            tone={AGENT_TONE[status] ?? "neutral"}
            pulse={AGENT_TONE[status] === "copper"}
            title={status}
          />
          <span className="min-w-0 flex-1 truncate font-display text-[12px] text-ink">
            {agent.label ?? agent.name ?? agent.id}
          </span>
        </button>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{status}</span>
      </div>
      {subagentControllable(status) ? (
        <FollowUpBox
          placeholder={t("rail.seance.followUpPlaceholder")}
          buttonLabel={t("rail.seance.followUp")}
          disabled={busy}
          onSubmit={onFollowUp}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          {/* omp's resolveOwnedLiveSubagent rejects steering a settled agent:
              the only way back to a saved session is a fresh consult. */}
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            {t("rail.seance.settledNote")}
          </span>
          <Button size="xs" variant="outline" onClick={onAskAgain}>
            {t("rail.seance.askAgain")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SeancePane({ tabId }: { tabId: string }) {
  const t = useT();
  // The roster's own order is the display order (the Agents pane precedent):
  // omp already sequences agents by start, and inventing a sort here would
  // fight it on every roster frame.
  const subagents = useStore((s) => s.rpc[tabId]?.subagents) ?? [];
  const consults = subagents.filter((agent) => agent.agent === "seance");
  const native = useStore((s) =>
    supportsSeance(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  const selected = useStore((s) => s.rpc[tabId]?.selectedSubagent) ?? null;
  const busyMap = useStore((s) => s.rpc[tabId]?.subagentControlBusy) ?? {};
  const tab = useStore((s) => s.tabs.find((candidate) => candidate.tabId === tabId));
  const openSeanceDialog = useStore((s) => s.openSeanceDialog);
  const openSubagent = useStore((s) => s.openSubagent);
  const closeSubagent = useStore((s) => s.closeSubagent);
  const steerSubagent = useStore((s) => s.steerSubagent);

  const newConsult = (): void => {
    openSeanceDialog({
      projectCwd: tab?.projectCwd ?? "",
      instanceId: tab?.instanceId ?? null,
      sourceTabId: tabId,
    });
  };

  if (!native) {
    // Floor plan §6 (same shape as the Side questions pane): the gate reads
    // as a requirement, and no launch control exists to dispatch through.
    return (
      <div className="px-3 py-2.5">
        <p role="status" className="rounded-md border border-line bg-raised px-2 py-1.5 text-[11px] text-ink-mid">
          {t("rail.seance.needsNewerOmp", { version: SEANCE_MIN_OMP })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 px-3 py-2.5">
      <div className="flex items-center justify-end">
        <Button size="xs" variant="outline" onClick={newConsult}>
          {t("rail.seance.newConsult")}
        </Button>
      </div>

      {consults.length === 0 ? (
        <Empty title={t("rail.seance.emptyTitle")} hint={t("rail.seance.emptyHint")} />
      ) : (
        <div className="space-y-2">
          {consults.map((agent) => (
            <ConsultCard
              key={agent.id}
              agent={agent}
              selected={selected === agent.id}
              busy={busyMap[agent.id] !== undefined}
              onToggle={() =>
                selected === agent.id ? closeSubagent(tabId) : openSubagent(tabId, agent.id)
              }
              onFollowUp={(question) => void steerSubagent(tabId, agent.id, question)}
              onAskAgain={newConsult}
            />
          ))}
        </div>
      )}
    </div>
  );
}
