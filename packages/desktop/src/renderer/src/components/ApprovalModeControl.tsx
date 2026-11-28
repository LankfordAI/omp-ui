import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ApprovalMode } from "@omp-ui/core/types";
import { APPROVAL_SETTING_KEY } from "@omp-ui/core/omp-settings-keys";
import { APPROVAL_MODES } from "@omp-ui/core/approval";
import { backendFor } from "../backend";
import { cn } from "../lib/cn";
import { ASK_AND_REMEMBER_MIN_OMP, supportsAskAndRemember } from "../lib/ask-and-remember";
import { findOwner, useStore } from "../store";
import { Capsule, Label } from "./ui";

/**
 * The session approval-mode control (issue #681, ADR-0038). omp binds
 * `tools.approvalMode` at process start, so a change relaunches the session —
 * the sheet row says so, and the chip only ever marks a session that PINNED a
 * tier (mirroring the fastChip gating). `inherit` writes no overlay: omp then
 * resolves its own global/project config, whose absent key means yolo.
 *
 * Subagents are never governed by the session mode — only the user's
 * `tools.approval` policy is theirs — and a PTY session's prompts render in
 * its own embedded TUI; both facts are hint copy, not behavior.
 */

const MODE_TITLE: Record<ApprovalMode | "inherit", string> = {
  inherit: "inherit — omp's own config decides",
  "always-ask": "always-ask — every tool waits for your approval",
  "always-ask-cached": "always-ask-cached — Ask and remember: file reads wait too, and an answer can remember the file or folder",
  write: "write — mutating tools wait for your approval",
  yolo: "yolo — nothing waits for approval except restricted folders",
};

export function ApprovalModeControl({
  tabId,
  layout = "inline",
  className,
}: {
  tabId: string;
  layout?: "inline" | "sheet";
  className?: string;
}) {
  const { mode, isRoutine, isPty, projectCwd, instanceId } = useStore(
    useShallow((s) => {
      const owner = findOwner(s.state, tabId);
      const rec = owner?.record;
      return {
        mode: rec?.approvalMode ?? null,
        isRoutine: rec?.routine != null,
        isPty: rec?.mode === "pty",
        projectCwd: rec?.projectCwd ?? null,
        instanceId: owner?.instanceId ?? null,
      };
    }),
  );
  const setSessionApprovalMode = useStore((s) => s.setSessionApprovalMode);
  // installed omp, a joined-instance one on the remote, whose running
  // version is the best proxy.
  const askAndRemember = useStore((s) =>
    supportsAskAndRemember(
      instanceId === null
        ? s.ompUpdate.installedVersion
        : (s.rpc[tabId]?.capabilities?.ompVersion ?? null),
    ),
  );

  if (isRoutine) return null;
  if (layout === "sheet") {
    return (
      <ApprovalSheet
        mode={mode}
        isPty={isPty}
        projectCwd={projectCwd}
        instanceId={instanceId}
        askAndRemember={askAndRemember}
        className={className}
        onPick={(next) => void setSessionApprovalMode(tabId, next)}
      />
    );
  }

  if (mode === null) return null;
  return (
    <Capsule
      tone="copper"
      title={`approval mode pinned to ${mode} · change it under session modes`}
      className={cn("h-6", className)}
    >
      <span className="px-1.5 font-mono text-xs">{mode}</span>
    </Capsule>
  );
}

function ApprovalSheet({
  mode,
  isPty,
  projectCwd,
  instanceId,
  askAndRemember,
  className,
  onPick,
}: {
  mode: ApprovalMode | null;
  isPty: boolean;
  projectCwd: string | null;
  instanceId: string | null;
  askAndRemember: boolean;
  className?: string;
  onPick: (next: ApprovalMode | null) => void;
}) {
  // Read on open, never while closed: what omp's own config resolves to when
  // this session inherits (the snapshot's `value` is already layer-resolved).
  // A remote session's global layer cannot be read from here, so it shows no
  // effective value — same rule as the subagent-models popover.
  const [effective, setEffective] = useState<string | null>(null);
  useEffect(() => {
    setEffective(null);
    if (mode !== null || projectCwd === null || instanceId !== null) return;
    let stale = false;
    void backendFor(null).readOmpSettings(projectCwd).then(
      (snap) => {
        if (stale || snap.error !== null) return;
        const entry = snap.entries.find((e) => e.key === APPROVAL_SETTING_KEY);
        if (typeof entry?.value === "string") setEffective(entry.value);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [mode, projectCwd, instanceId]);

  return (
    <div className={cn("mt-2", className)} data-approval-mode-sheet>
      <div className="flex items-center justify-between gap-2">
        <Label>approval mode</Label>
        {mode === null && effective !== null && (
          <span className="font-mono text-xs text-ink-faint">
            {`omp resolves: ${effective}`}
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label="approval mode"
        className="mt-1 flex items-center gap-0.5 rounded-md border border-line bg-void p-0.5"
      >
        {[null, ...APPROVAL_MODES].map((choice) => {
          // A session already pinned to the tier keeps its button enabled.
          const gated = choice === "always-ask-cached" && !askAndRemember && choice !== mode;
          return (
            <button
              key={choice ?? "inherit"}
              type="button"
              aria-pressed={choice === mode}
              disabled={gated}
              title={
                gated
                  ? `always-ask-cached needs omp ${ASK_AND_REMEMBER_MIN_OMP} or later.`
                  : MODE_TITLE[choice ?? "inherit"]
              }
              onClick={() => onPick(choice)}
              className={cn(
                "min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-xs leading-4",
                "transition-colors duration-150",
                choice === mode
                  ? "bg-raised text-ink"
                  : "text-ink-dim hover:bg-hover hover:text-ink-mid disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-dim",
              )}
            >
              {choice === null ? "inherit" : choice}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs leading-snug text-ink-faint">
        Changing the mode relaunches the session.
        {" "}
        {isPty ? "A terminal session shows its prompts in its own terminal." : "Subagents ignore the session mode — your tools.approval policy governs them."}
      </p>
    </div>
  );
}
