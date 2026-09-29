import { useEffect, useState } from "react";
import type { ApprovalMode } from "@omp-ui/core/types";
import { APPROVAL_SETTING_KEY } from "@omp-ui/core/omp-settings-keys";
import { backendFor } from "../backend";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { findOwner, findRecord, useStore } from "../store";
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

const MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];

export function ApprovalModeControl({
  tabId,
  layout = "inline",
  className,
}: {
  tabId: string;
  layout?: "inline" | "sheet";
  className?: string;
}) {
  const t = useT();
  const record = useStore((s) => findRecord(s.state, tabId));
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const setSessionApprovalMode = useStore((s) => s.setSessionApprovalMode);
  const mode = record?.approvalMode ?? null;

  if (layout === "sheet") {
    return (
      <ApprovalSheet
        mode={mode}
        isPty={record?.mode === "pty"}
        projectCwd={record?.projectCwd ?? null}
        instanceId={instanceId}
        className={className}
        onPick={(next) => void setSessionApprovalMode(tabId, next)}
      />
    );
  }

  if (mode === null) return null;
  return (
    <Capsule
      tone="copper"
      title={t("hud.approval.chipTitle", { mode })}
      className={cn("h-6", className)}
    >
      <span className="px-1.5 font-mono text-[10px]">{mode}</span>
    </Capsule>
  );
}

function ApprovalSheet({
  mode,
  isPty,
  projectCwd,
  instanceId,
  className,
  onPick,
}: {
  mode: ApprovalMode | null;
  isPty: boolean;
  projectCwd: string | null;
  instanceId: string | null;
  className?: string;
  onPick: (next: ApprovalMode | null) => void;
}) {
  const t = useT();
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
        <Label>{t("hud.approval.labelLong")}</Label>
        {mode === null && effective !== null && (
          <span className="font-mono text-[10px] text-ink-faint">
            {t("hud.approval.effective", { mode: effective })}
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label={t("hud.approval.labelLong")}
        className="mt-1 flex items-center gap-0.5 rounded-md border border-line bg-void p-0.5"
      >
        {[null, ...MODES].map((choice) => (
          <button
            type="button"
            aria-pressed={choice === mode}
            title={t(
              `hud.approval.${choice === null ? "inherit" : choice === "always-ask" ? "alwaysAsk" : choice}Title`,
            )}
            onClick={() => onPick(choice)}
            className={cn(
              "min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-[10px] leading-4",
              "transition-colors duration-150",
              choice === mode
                ? "bg-raised text-ink"
                : "text-ink-dim hover:bg-hover hover:text-ink-mid",
            )}
          >
            {choice === null ? t("settings.omp.approvalInherit") : choice}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-ink-faint">
        {t("hud.approval.relaunchHint")}
        {" "}
        {isPty ? t("hud.approval.ptyHint") : t("hud.approval.subagentHint")}
      </p>
    </div>
  );
}
