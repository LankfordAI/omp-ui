import { useState } from "react";
import type { JudgeModelSnapshot } from "@omp-ui/core/types";
import { OMP_JUDGE_ROLE_ID } from "@omp-ui/core/omp-settings-keys";
import { useStore } from "../../store";
import { displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { Button } from "../ui";
import { CommitField } from "./rows";

type JudgeModelsLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; snapshot: JudgeModelSnapshot };

/**
 * The omp page's judge model-role row (issue #669). The browse list comes from
 * the installed binary's `omp models --kind judge` catalog — never a curated
 * omp-ui list (ADR-0027 lineage). Selectors are OPAQUE: matched, stored, and
 * committed by string equality, never through parseModelRole, so a trailing
 * `:word` stays part of the id (the webSearchRoleSelection precedent). A
 * stored value outside the current catalog stays visible, pressed and
 * labelled, like the dictation picker's out-of-catalog row.
 */
export function JudgeRoleRow({
  value,
  pending,
  onCommit,
}: {
  value: string;
  pending: boolean;
  onCommit: (raw: string) => void;
}) {
  const t = useT();
  const readJudgeModels = useStore((s) => s.readJudgeModels);
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<JudgeModelsLoad>({ status: "idle" });

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    // One probe per mount, exactly like the dictation picker: revisiting
    // Settings re-reads the catalog belonging to the omp binary and keys.
    if (next && load.status === "idle") {
      setLoad({ status: "loading" });
      readJudgeModels().then(
        (snapshot) => setLoad({ status: "loaded", snapshot }),
        (err: unknown) =>
          setLoad({
            status: "loaded",
            snapshot: { models: [], discovered: false, error: displayMessage(err) },
          }),
      );
    }
  };

  const pick = (raw: string): void => {
    setOpen(false);
    onCommit(raw);
  };

  const trimmed = value.trim();
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 font-mono text-[11px] text-ink-mid">
          {OMP_JUDGE_ROLE_ID}
        </span>
        <CommitField
          current={value}
          kind="text"
          label={t("settings.omp.modelRoleLabel", { role: OMP_JUDGE_ROLE_ID })}
          placeholder={t("settings.omp.judgePlaceholder")}
          disabled={pending}
          className="flex-1"
          onCommit={onCommit}
        />
        <Button size="xs" disabled={pending} onClick={toggle}>
          {t("settings.omp.judgeBrowse")}
        </Button>
      </div>
      {open && load.status === "loading" && (
        <p className="mt-1.5 text-[11px] text-ink-faint">{t("settings.omp.reading")}</p>
      )}
      {open && load.status === "loaded" && (
        <div className="mt-1.5 flex min-w-0 flex-col gap-2">
          <div
            role="group"
            aria-label={t("settings.omp.modelRoleLabel", { role: OMP_JUDGE_ROLE_ID })}
            className="divide-y divide-line-soft rounded-md border border-line bg-raised"
          >
            {(() => {
              const options: Array<{ id: string; label: string }> = [
                { id: "", label: t("settings.omp.judgeUnset") },
              ];
              if (
                trimmed !== "" &&
                !load.snapshot.models.some((m) => m.selector === trimmed)
              ) {
                options.push({
                  id: trimmed,
                  label: `${trimmed}${t("settings.omp.judgeOutsideCatalog")}`,
                });
              }
              for (const model of load.snapshot.models) {
                options.push({ id: model.selector, label: `${model.name} · ${model.selector}` });
              }
              return options.map((option) => {
                const selected = option.id === trimmed;
                return (
                  <button
                    key={option.id || "unset"}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => pick(option.id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150",
                      selected
                        ? "bg-hover text-ink"
                        : "text-ink-mid hover:bg-hover/50 focus-visible:bg-hover/50 focus-visible:outline-none",
                    )}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate font-mono text-[11px]",
                        selected && "font-medium",
                      )}
                    >
                      {option.label}
                    </span>
                  </button>
                );
              });
            })()}
          </div>
          {load.snapshot.discovered && load.snapshot.models.length === 0 && (
            <p className="text-[10px] text-ink-faint">{t("settings.omp.judgeNone")}</p>
          )}
          {!load.snapshot.discovered && (
            <p className="text-[10px] text-ink-faint">
              {t("settings.omp.judgeLoadFailed", { message: load.snapshot.error ?? "" })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
