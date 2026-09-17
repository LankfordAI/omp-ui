import { useEffect, useState } from "react";
import type { OmpSettingEntry, OmpSettingValue, ProjectSubagentModelsResult } from "@omp-ui/core/types";
import { OMP_SUBAGENT_MODELS_KEY } from "@omp-ui/core/omp-settings-keys";
import { SUBAGENT_MODEL_INHERIT } from "@omp-ui/core/subagent-model";
import { backend, displayMessage } from "../../backend";
import { findOwner, useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { Button, Label } from "../ui";
import { layerBadge } from "./rows";
import { ModelPalette } from "../ModelSelector";

/**
 * The omp page's "Subagent models" section (ADR-0031): one row per discovered
 * agent, each editable at the Global layer (the whole merged record via
 * `omp config set`, REPLACE-not-merge like modelRoles) or at the Project
 * layer (one entry at a time, so hand-written siblings survive).
 *
 * Row badges are per agent, not per record: "project" when the project layer
 * names the agent, else "global" when the effective value does, else omp's
 * default. Edits re-read both layers from disk — nothing is optimistic.
 */
const EMPTY_ROSTER: string[] = [];

/** The record value of one entry, or {} when unset/not a record. */
function recordOf(value: OmpSettingValue | undefined): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/** The row's display label for one stored selector. */
function valueLabel(value: string | undefined, defaultLabel: string, sessionLabel: string): string {
  if (value === undefined) return defaultLabel;
  return value === SUBAGENT_MODEL_INHERIT ? sessionLabel : value;
}

export function SubagentModelsSection({
  entry,
  projectCwd,
  pendingKey,
  commit,
  retry,
}: {
  /** The task.agentModelOverrides snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  projectCwd: string | null;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const t = useT();
  const roster = useStore((s) => s.state?.agentRoster ?? EMPTY_ROSTER);
  const activeTabId = useStore((s) => s.activeTabId);
  const models = useStore((s) =>
    activeTabId === null ? undefined : s.rpc[activeTabId]?.availableModels,
  );
  const instanceId = useStore((s) =>
    activeTabId === null ? null : (findOwner(s.state, activeTabId)?.instanceId ?? null),
  );

  // A focused session defaults to its project layer: the narrower, safer
  // edit target. With no session focused, only Global is available.
  const [scope, setScope] = useState<"global" | "project">(
    projectCwd === null ? "global" : "project",
  );
  const [projectRead, setProjectRead] = useState<ProjectSubagentModelsResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [paletteAgent, setPaletteAgent] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The project layer is a file the snapshot does not model; re-read it on
  // mount and after every project write. No project focused → no read.
  useEffect(() => {
    if (projectCwd === null) {
      setProjectRead(null);
      return;
    }
    let stale = false;
    backend.getProjectSubagentModels(projectCwd).then(
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

  const effectiveMap = recordOf(entry.value);
  const globalMap = recordOf(entry.globalValue);
  const projectMap = projectRead?.map ?? {};
  const unsupported = projectRead?.layer.shape === "unsupported" ? projectRead.layer : null;
  const projectEditable = projectCwd !== null && unsupported === null;

  const pick = (agent: string, selector: string | null): void => {
    if (scope === "global") {
      // REPLACE-not-merge: the whole GLOBAL record goes out, with the agent's
      // key omitted when cleared — merging against globalValue, never the
      // effective value, so a project value is not baked into the global file.
      const merged: Record<string, unknown> = { ...globalMap };
      if (selector === null) delete merged[agent];
      else merged[agent] = selector;
      commit(OMP_SUBAGENT_MODELS_KEY, merged);
      return;
    }
    if (projectCwd === null) return;
    setPending(true);
    backend.setProjectSubagentModel(projectCwd, agent, selector).then(
      () => {
        setLocalError(null);
        setPending(false);
        // Both layers are re-read from disk: the project file through the
        // effect-free reload below, the effective snapshot through the page.
        if (projectCwd !== null) {
          void backend.getProjectSubagentModels(projectCwd).then(setProjectRead);
        }
        retry();
      },
      (err: unknown) => {
        setPending(false);
        setLocalError(displayMessage(err));
      },
    );
  };

  const refreshRoster = (): void => {
    setRefreshing(true);
    backend.refreshAgentRoster().then(
      () => setRefreshing(false),
      (err: unknown) => {
        setRefreshing(false);
        setLocalError(displayMessage(err));
      },
    );
  };

  const pendingWrite = pendingKey === OMP_SUBAGENT_MODELS_KEY || pending;

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.subagentModels")}</Label>
        {layerBadge(entry.layer)}
        <span className="ml-auto flex items-center gap-1" role="group" aria-label={t("settings.omp.subagentScope")}>
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
              {choice === "global" ? t("settings.omp.subagentScopeGlobal") : t("settings.omp.subagentScopeProject")}
            </button>
          ))}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.subagentModelsHint")}
      </p>
      {unsupported !== null && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] text-copper">
          {t("settings.omp.subagentUnsupported", { reason: unsupported.reason })}
        </p>
      )}
      {localError !== null && (
        <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {localError}
        </p>
      )}

      <div className="mt-1.5 divide-y divide-line-soft">
        {roster.map((agent) => {
          const effective = effectiveMap[agent];
          const layer =
            projectMap[agent] !== undefined ? "project" : effective !== undefined ? "global" : "default";
          // The palette edits the scope's OWN value: clearing picks "omp
          // default", which deletes the key at that layer only.
          const scopedValue =
            scope === "global"
              ? (globalMap[agent] as string | undefined)
              : projectMap[agent];
          return (
            <div key={agent} className="flex items-center gap-3 py-1.5">
              <span className="w-32 shrink-0 truncate font-mono text-[11px] text-ink-mid">{agent}</span>
              {layerBadge(layer)}
              <button
                type="button"
                disabled={pendingWrite || (scope === "project" && !projectEditable)}
                onClick={() => setPaletteAgent(agent)}
                title={
                  typeof effective === "string"
                    ? `${agent}: ${effective}`
                    : t("settings.omp.subagentRowDefault", { agent })
                }
                className="ml-auto max-w-72 truncate rounded-md border border-line bg-raised px-2 py-1 font-mono text-[11px] text-ink-mid transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-35"
              >
                {valueLabel(
                  scopedValue,
                  t("settings.omp.subagentDefault"),
                  t("composer.model.subagentSessionModel"),
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <Button size="xs" disabled={refreshing} onClick={refreshRoster}>
          {refreshing ? t("settings.omp.subagentRefreshing") : t("settings.omp.subagentRefresh")}
        </Button>
        {roster.length === 0 && (
          <span className="text-[11px] text-ink-faint">{t("settings.omp.subagentRosterEmpty")}</span>
        )}
      </div>

      {paletteAgent !== null && (
        <ModelPalette
          variant="subagent"
          instanceId={instanceId}
          models={models ?? []}
          current={
            scope === "global"
              ? ((globalMap[paletteAgent] as string | undefined) ?? null)
              : (projectMap[paletteAgent] ?? null)
          }
          allowInherit
          onClose={() => setPaletteAgent(null)}
          onPick={(selector) => {
            const agent = paletteAgent;
            setPaletteAgent(null);
            pick(agent, selector);
          }}
        />
      )}
    </section>
  );
}
