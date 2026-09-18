import { useEffect, useState } from "react";
import type { OmpSettingEntry, OmpSettingValue, ProjectScalarResult } from "@omp-ui/core/types";
import { OMP_MAX_CONCURRENCY_KEY } from "@omp-ui/core/omp-settings-keys";
import { backend, displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { Button, Label } from "../ui";
import { CommitField, layerBadge } from "./rows";

/**
 * The omp page's "Subagent concurrency" section (issue #569): the one number
 * omp resizes its subagent semaphore from, editable at the Global layer
 * (`omp config set`) or at the Project layer (one key written in place into
 * the focused project's `.omp/config.yml`, so hand-written siblings survive),
 * structurally the SubagentModelsSection pattern (ADR-0031).
 *
 * A clear button removes the project override so the badge falls back to
 * global/default. Edits re-read both layers from disk — nothing is optimistic.
 */
export function SubagentConcurrencySection({
  entry,
  projectCwd,
  pendingKey,
  commit,
  retry,
}: {
  /** The task.maxConcurrency snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  projectCwd: string | null;
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
    if (projectCwd === null) {
      setProjectRead(null);
      return;
    }
    let stale = false;
    backend.getProjectMaxConcurrency(projectCwd).then(
      (result) => {
        if (!stale) setProjectRead(result);
      },
      (err: unknown) => {
        if (!stale) setLocalError(displayMessage(err));
      },
    );
    return () => {
      stale = true;
    };
  }, [projectCwd]);

  if (entry === undefined) return null;

  const unsupported =
    projectRead !== null && projectRead.layer.shape === "unsupported" ? projectRead.layer : null;
  const projectEditable = projectCwd !== null && unsupported === null;
  const pendingWrite = pendingKey === OMP_MAX_CONCURRENCY_KEY || pending;

  // The scope's OWN value: what the field edits. A read-back number arrives as
  // a bare string from the writer's grammar; String() renders either form.
  const scopedValue =
    scope === "global"
      ? entry.globalValue === undefined
        ? ""
        : String(entry.globalValue)
      : projectRead?.layer.shape === "value"
        ? String(projectRead.value)
        : "";

  const rereadProject = (): void => {
    if (projectCwd !== null) {
      void backend.getProjectMaxConcurrency(projectCwd).then(setProjectRead);
    }
  };

  const writeProject = (value: number | null): void => {
    if (projectCwd === null) return;
    setPending(true);
    backend.setProjectMaxConcurrency(projectCwd, value).then(
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

  const commitValue = (raw: string): void => {
    const value = Number(raw);
    // Empty or non-finite reverts: like every omp-page number row, this
    // surface clears overrides with its own button, not with a blank field.
    if (raw.trim() === "" || !Number.isFinite(value)) return;
    if (scope === "global") {
      commit(OMP_MAX_CONCURRENCY_KEY, value);
      return;
    }
    writeProject(value);
  };

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.subagentConcurrency")}</Label>
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
        {t("settings.omp.subagentConcurrencyHint")}
      </p>
      {unsupported !== null && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] text-copper">
          {t("settings.omp.subagentConcurrencyUnsupported", { reason: unsupported.reason })}
        </p>
      )}
      {localError !== null && (
        <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {localError}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-3 py-1.5">
        <CommitField
          current={scopedValue}
          kind="number"
          label={OMP_MAX_CONCURRENCY_KEY}
          placeholder={entry.value === undefined ? "" : String(entry.value)}
          disabled={pendingWrite || (scope === "project" && !projectEditable)}
          className="w-24"
          onCommit={commitValue}
        />
        {scope === "project" && (
          <Button
            size="xs"
            disabled={pendingWrite || !projectEditable || projectRead?.layer.shape !== "value"}
            onClick={() => writeProject(null)}
          >
            {t("settings.omp.subagentConcurrencyClear")}
          </Button>
        )}
      </div>
    </section>
  );
}
