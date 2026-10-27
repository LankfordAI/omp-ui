import { useEffect, useState } from "react";
import type {
  OmpSettingEntry,
  OmpSettingValue,
  ProjectSpendCapsResult,
  SpendCapKey,
} from "@omp-ui/core/types";
import { backend, displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { Button, Label } from "../ui";
import { CommitField, layerBadge } from "./rows";

/**
 * The omp page's "Spend caps" section (issue #952): omp 18.13's per-session
 * `session.warnCost` (warn once) and `session.maxCost` (stop sending model
 * requests), editable at the Global layer (`omp config set`, cleared through
 * `omp config reset`) or at the Project layer (one key written in place into
 * the focused project's `.omp/config.yml`), structurally the
 * SubagentConcurrencySection pattern.
 *
 * omp refuses a cap of 0 or below, and the project file bypasses its
 * validator, so this section refuses them before any write. Edits re-read
 * both layers from disk — nothing is optimistic.
 */
export function SpendCapSection({
  warnEntry,
  maxEntry,
  projectCwd,
  pendingKey,
  commit,
  retry,
}: {
  /** The session.warnCost snapshot entry; undefined when omp predates the key. */
  warnEntry: OmpSettingEntry | undefined;
  /** The session.maxCost snapshot entry; undefined when omp predates the key. */
  maxEntry: OmpSettingEntry | undefined;
  projectCwd: string | null;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const t = useT();
  const published = warnEntry !== undefined || maxEntry !== undefined;
  // Project opens only when the project layer already supplies the stop
  // amount: a cap is a machine-wide habit more often than a per-repo one.
  const [scope, setScope] = useState<"global" | "project">(
    projectCwd !== null && maxEntry?.layer === "project" ? "project" : "global",
  );
  const [projectRead, setProjectRead] = useState<ProjectSpendCapsResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The project layer is a file the snapshot does not model; re-read it on
  // mount and after every project write. No project focused, or an omp that
  // publishes neither key → no read.
  useEffect(() => {
    if (!published || projectCwd === null) {
      setProjectRead(null);
      return;
    }
    let stale = false;
    backend.getProjectSpendCaps(projectCwd).then(
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
  }, [projectCwd, published]);

  if (!published) return null;

  const unsupported =
    projectRead === null
      ? null
      : projectRead.warnCost.layer.shape === "unsupported"
        ? projectRead.warnCost.layer
        : projectRead.maxCost.layer.shape === "unsupported"
          ? projectRead.maxCost.layer
          : null;
  const projectEditable = projectCwd !== null && unsupported === null;
  const outOfOrder =
    typeof warnEntry?.value === "number" &&
    typeof maxEntry?.value === "number" &&
    warnEntry.value >= maxEntry.value;

  const rereadProject = (): void => {
    if (projectCwd !== null) {
      void backend.getProjectSpendCaps(projectCwd).then(setProjectRead);
    }
  };

  const writeProject = (child: SpendCapKey, value: number | null): void => {
    if (projectCwd === null) return;
    setPending(true);
    backend.setProjectSpendCap(projectCwd, child, value).then(
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

  const resetGlobal = (key: string): void => {
    setPending(true);
    backend.resetOmpSetting(key).then(
      () => {
        setLocalError(null);
        setPending(false);
        retry();
      },
      (err: unknown) => {
        setPending(false);
        setLocalError(displayMessage(err));
      },
    );
  };

  const commitValue = (entry: OmpSettingEntry, child: SpendCapKey, raw: string): void => {
    const value = Number(raw);
    // Empty or non-finite reverts: the clear button unsets a cap, not a blank field.
    if (raw.trim() === "" || !Number.isFinite(value)) return;
    if (value <= 0) {
      setLocalError(t("settings.omp.spendCapPositive"));
      return;
    }
    if (scope === "global") {
      setLocalError(null);
      commit(entry.key, value);
      return;
    }
    writeProject(child, value);
  };

  const clearValue = (entry: OmpSettingEntry, child: SpendCapKey): void => {
    if (scope === "global") resetGlobal(entry.key);
    else writeProject(child, null);
  };

  const row = (entry: OmpSettingEntry | undefined, child: SpendCapKey, label: string) => {
    if (entry === undefined) return null;
    const pendingWrite = pendingKey === entry.key || pending;
    const disabled = pendingWrite || (scope === "project" && !projectEditable);
    // The scope's OWN value: what the field edits. A read-back number arrives
    // as a bare string from the writer's grammar; String() renders either form.
    const own = projectRead?.[child];
    const scopedValue =
      scope === "global"
        ? entry.globalValue === undefined
          ? ""
          : String(entry.globalValue)
        : own?.layer.shape === "value"
          ? String(own.value)
          : "";
    const clearable =
      scope === "global" ? entry.globalValue !== undefined : own?.layer.shape === "value";
    return (
      <div className="flex items-center gap-3 py-1.5">
        <span className="w-20 shrink-0 text-xs text-ink-mid">{label}</span>
        {layerBadge(entry.layer)}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-xs text-ink-faint">$</span>
          <CommitField
            current={scopedValue}
            kind="number"
            step="0.01"
            label={entry.key}
            placeholder={entry.value === undefined ? "" : String(entry.value)}
            disabled={disabled}
            className="w-24"
            onCommit={(raw) => commitValue(entry, child, raw)}
          />
          <Button size="xs" disabled={disabled || !clearable} onClick={() => clearValue(entry, child)}>
            {t("settings.omp.spendCapClear")}
          </Button>
        </span>
      </div>
    );
  };

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.spendCaps")}</Label>
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
        {t("settings.omp.spendCapsHint")}
      </p>
      {unsupported !== null && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] text-copper">
          {t("settings.omp.spendCapUnsupported", { reason: unsupported.reason })}
        </p>
      )}
      {outOfOrder && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] text-copper">
          {t("settings.omp.spendCapOrder")}
        </p>
      )}
      {localError !== null && (
        <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {localError}
        </p>
      )}

      <div className="mt-1.5">
        {row(warnEntry, "warnCost", t("settings.omp.spendCapWarn"))}
        {row(maxEntry, "maxCost", t("settings.omp.spendCapMax"))}
      </div>
    </section>
  );
}
