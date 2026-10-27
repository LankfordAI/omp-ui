import { useEffect, useState } from "react";
import type { ApprovalMode, OmpSettingEntry, OmpSettingValue, ProjectScalarResult } from "@omp-ui/core/types";
import { APPROVAL_MODES, isApprovalMode } from "@omp-ui/core/approval";
import { APPROVAL_SETTING_KEY } from "@omp-ui/core/omp-settings-keys";
import { backend, displayMessage } from "../../backend";
import { findOwner, useStore } from "../../store";
import {
  ASK_AND_REMEMBER_MIN_OMP,
  FORGET_APPROVALS_COMMAND,
  supportsAskAndRemember,
} from "../../lib/ask-and-remember";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { Button, Label } from "../ui";
import { FIELD, layerBadge } from "./rows";

/**
 * The omp page's "Tool approval" section (issue #681, #950, ADR-0038): the tier
 * omp gates its tools with, editable at the Global layer (`omp config set`) or
 * at the Project layer (one key written in place into the focused project's
 * `.omp/config.yml`, so hand-written siblings survive) — structurally the
 * Subagent concurrency pattern.
 *
 * The section renders the four tiers as its own select rather than the generic
 * row, because it adds Project layering and the version gate: `always-ask-cached`
 * (Ask and remember) needs omp ≥ 18.12.3, since an older omp resolves the unknown
 * value to yolo. Clearing the Project value falls back to Global (inherit =
 * remove the key); the Global layer has no delete rail, so an unset global layer
 * shows as unset — where omp resolves the absent key to its own default, yolo.
 *
 * A forget row runs `/forget-approvals` in the focused session, enabled only for
 * a live native session this computer owns whose roster advertises the builtin.
 */
export function ApprovalModeSection({
  entry,
  projectCwd,
  tabId,
  pendingKey,
  commit,
  retry,
}: {
  /** The tools.approvalMode snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  projectCwd: string | null;
  /** The focused tab; the forget action runs in it. */
  tabId: string | null;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const t = useT();
  // A focused session defaults to its project layer: the narrower, safer
  // edit target. With no session focused, only Global is available.
  const [scope, setScope] = useState<"global" | "project">(
    projectCwd === null ? "global" : "project",
  );
  const [projectRead, setProjectRead] = useState<ProjectScalarResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The project layer is a file the snapshot does not model; re-read it on
  // mount and after every project write. No project focused → no read.
  useEffect(() => {
    if (entry === undefined) return; // an omp that predates the key has nothing to read
    if (projectCwd === null) {
      setProjectRead(null);
      return;
    }
    let live = true;
    backend.getProjectApprovalMode(projectCwd).then(
      (result) => {
        if (live) setProjectRead(result);
      },
      () => {
        if (live) setProjectRead(null);
      },
    );
    return () => {
      live = false;
    };
  }, [entry, projectCwd]);

  const askAndRemember = useStore((s) => supportsAskAndRemember(s.ompUpdate.installedVersion));
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  // Forget runs inside a session: only a live native session this computer
  // owns, whose roster advertises the builtin (omp ≥ 18.12.3).
  const forgetTab = useStore((s) => {
    if (tabId === null || s.exited[tabId] !== undefined) return null;
    if ((findOwner(s.state, tabId)?.instanceId ?? null) !== null) return null;
    const advertised =
      s.rpc[tabId]?.commands.some((c) => c.name === FORGET_APPROVALS_COMMAND) ?? false;
    return advertised ? tabId : null;
  });
  const [forgetPending, setForgetPending] = useState(false);
  const [forgetSentFor, setForgetSentFor] = useState<string | null>(null);

  if (entry === undefined) return null;

  const unsupported =
    projectRead !== null && projectRead.layer.shape === "unsupported" ? projectRead.layer : null;
  const projectEditable = projectCwd !== null && unsupported === null;
  const pendingWrite = pendingKey === APPROVAL_SETTING_KEY || pending;

  // The scope's OWN value: what the select edits. A project layer with no key
  // IS the inherit state; an absent global layer has no name to select.
  const scopedValue =
    scope === "global"
      ? entry.globalValue === undefined
        ? ""
        : String(entry.globalValue)
      : projectRead?.layer.shape === "value"
        ? String(projectRead.value)
        : "inherit";

  const rereadProject = (): void => {
    if (projectCwd !== null) {
      void backend.getProjectApprovalMode(projectCwd).then(setProjectRead);
    }
  };

  const writeProject = (value: ApprovalMode | null): void => {
    if (projectCwd === null) return;
    setPending(true);
    backend.setProjectApprovalMode(projectCwd, value).then(
      () => {
        setLocalError(null);
        setPending(false);
        // Both layers are re-read from disk: the project file through the
        // call below, the effective snapshot through the page's retry.
        rereadProject();
        retry();
      },
      (err: unknown) => {
        setPending(false);
        setLocalError(displayMessage(err));
      },
    );
  };

  const pick = (raw: string): void => {
    if (raw === "") return;
    const tier = isApprovalMode(raw) ? raw : null;
    if (scope === "global") {
      // The global layer has no delete rail — inherit there means "no key",
      // which the unset placeholder already shows; only a tier commits.
      if (tier !== null) commit(APPROVAL_SETTING_KEY, tier);
      return;
    }
    writeProject(tier);
  };

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.approval")}</Label>
        {layerBadge(entry.layer)}
        <span
          className="ml-auto flex items-center gap-1"
          role="group"
          aria-label={t("settings.omp.subagentScope")}
        >
          {(["global", "project"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={choice === "project" && !projectEditable}
              title={
                choice === "project" && !projectEditable
                  ? projectCwd === null
                    ? t("settings.omp.noSessionFocused")
                    : (unsupported?.reason ?? "")
                  : undefined
              }
              onClick={() => setScope(choice)}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] transition-colors",
                scope === choice
                  ? "bg-raised text-ink"
                  : "text-ink-faint hover:text-ink-mid disabled:pointer-events-none disabled:opacity-35",
              )}
            >
              {choice === "global"
                ? t("settings.omp.subagentScopeGlobal")
                : t("settings.omp.subagentScopeProject")}
            </button>
          ))}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.approvalHint")}
      </p>
      {unsupported !== null && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] text-copper">
          {t("settings.omp.approvalUnsupported", { reason: unsupported.reason })}
        </p>
      )}
      {localError !== null && (
        <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {localError}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-3 py-1.5">
        <select
          aria-label={APPROVAL_SETTING_KEY}
          value={scopedValue}
          disabled={pendingWrite || (scope === "project" && !projectEditable)}
          onChange={(event) => pick(event.target.value)}
          className={FIELD}
        >
          {scopedValue === "" && (
            <option value="" disabled>
              {t("settings.rows.unset")}
            </option>
          )}
          {scope === "project" && (
            <option value="inherit">{t("settings.omp.approvalInherit")}</option>
          )}
          {APPROVAL_MODES.map((mode) => (
            <option
              key={mode}
              value={mode}
              disabled={
                mode === "always-ask-cached" && !askAndRemember && scopedValue !== "always-ask-cached"
              }
            >
              {mode}
            </option>
          ))}
        </select>
      </div>
      {!askAndRemember && (
        <p className="text-[11px] text-ink-faint">
          {t("settings.omp.approvalCachedNeedsOmp", { version: ASK_AND_REMEMBER_MIN_OMP })}
        </p>
      )}
      <div className="flex items-center gap-3 py-1.5">
        <Button
          size="xs"
          disabled={forgetTab === null || forgetPending}
          onClick={() => {
            if (forgetTab === null) return;
            const target = forgetTab;
            setForgetPending(true);
            void runSlashCommand(target, `/${FORGET_APPROVALS_COMMAND}`).finally(() => {
              setForgetPending(false);
              setForgetSentFor(target);
            });
          }}
        >
          {t("settings.omp.approvalForget")}
        </Button>
        <span className="text-[11px] leading-snug text-ink-faint">
          {forgetTab === null
            ? t("settings.omp.approvalForgetUnavailable")
            : forgetSentFor === forgetTab
              ? t("settings.omp.approvalForgetSent")
              : t("settings.omp.approvalForgetHint")}
        </span>
      </div>
    </section>
  );
}
