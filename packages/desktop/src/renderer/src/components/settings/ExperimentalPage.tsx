import { ROUTINE_COST_MAX_USD } from "@omp-ui/core/routine";
import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Switch } from "../ui";
import { CommitField, Row } from "./rows";

/** A committed USD draft: finite, 0..ROUTINE_COST_MAX_USD; anything else is dropped. */
function parseUsd(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= ROUTINE_COST_MAX_USD ? value : null;
}

/**
 * Settings → Experimental: independent app-global gates. Artifact library
 * keeps the authoritative registry flag: switching never optimistically
 * grants a guest writer or reference permission. Lab and the autoresearch
 * bridge remain separately controlled. Routines (ADR-0100) is host-local: its
 * spend defaults show only while it is on, and each run pins them at fire.
 */
export function ExperimentalPage() {
  const t = useT();
  const state = useStore((s) => s.state);
  const setExperimentsEnabled = useStore((s) => s.setExperimentsEnabled);
  const setAutoresearchEnabled = useStore((s) => s.setAutoresearchEnabled);
  const setArtifactLibraryEnabled = useStore((s) => s.setArtifactLibraryEnabled);
  const setRoutinesEnabled = useStore((s) => s.setRoutinesEnabled);
  const setRoutineSpendDefaults = useStore((s) => s.setRoutineSpendDefaults);
  const routinesOn = state?.routinesEnabled === true;
  const warnUsd = state?.routineWarnCostUsd ?? 2;
  const maxUsd = state?.routineMaxCostUsd ?? 5;
  return (
    <div className="px-4 py-3">
      <Row title={t("artifacts.settings.title")} hint={t("artifacts.settings.hint")}>
        <Switch on={state?.artifactLibraryEnabled === true} onChange={(on) => void setArtifactLibraryEnabled(on)} label={t("artifacts.settings.title")} />
      </Row>
      <Row
        title={t("settings.experimental.labTitle")}
        hint={t("settings.experimental.labHint")}
      >
        <Switch
          on={state?.experimentsEnabled === true}
          onChange={(next) => void setExperimentsEnabled(next)}
          label={t("settings.experimental.labTitle")}
        />
      </Row>
      <Row
        title={t("settings.experimental.autoresearchTitle")}
        hint={t("settings.experimental.autoresearchHint")}
      >
        <Switch
          on={state?.autoresearchEnabled === true}
          onChange={(next) => void setAutoresearchEnabled(next)}
          label={t("settings.experimental.autoresearchTitle")}
        />
      </Row>
      <Row
        title={t("settings.experimental.routinesTitle")}
        hint={t("settings.experimental.routinesHint")}
      >
        <Switch
          on={routinesOn}
          onChange={(next) => void setRoutinesEnabled(next)}
          label={t("settings.experimental.routinesTitle")}
        />
      </Row>
      {routinesOn && (
        <div className="ml-4 border-l border-line-soft pl-3">
          <Row title={t("settings.experimental.routineWarnCost")} hint={t("settings.experimental.routineCostHint")}>
            <CommitField
              kind="number"
              step="0.01"
              current={String(warnUsd)}
              label={t("settings.experimental.routineWarnCost")}
              disabled={false}
              className="w-24"
              onCommit={(raw) => {
                const value = parseUsd(raw);
                if (value !== null) void setRoutineSpendDefaults(value, maxUsd);
              }}
            />
          </Row>
          <Row title={t("settings.experimental.routineMaxCost")}>
            <CommitField
              kind="number"
              step="0.01"
              current={String(maxUsd)}
              label={t("settings.experimental.routineMaxCost")}
              disabled={false}
              className="w-24"
              onCommit={(raw) => {
                const value = parseUsd(raw);
                if (value !== null) void setRoutineSpendDefaults(warnUsd, value);
              }}
            />
          </Row>
        </div>
      )}
    </div>
  );
}

export function ExperimentalFooter() {
  const t = useT();
  return <p>{t("settings.experimental.footer")}</p>;
}
