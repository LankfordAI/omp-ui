import { ROUTINE_COST_MAX_USD } from "@omp-ui/core/routine";
import { useStore } from "../../store";
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
      <Row title="Artifact library" hint="Keep session-authored artifacts and their saved data on this machine. Experimental; off by default.">
        <Switch on={state?.artifactLibraryEnabled === true} onChange={(on) => void setArtifactLibraryEnabled(on)} label="Artifact library" />
      </Row>
      <Row
        title="Experiments lab (beta)"
        hint="Adds the Lab, the New experiment dialog, and the /autoresearch start and lab verbs. Off hides those surfaces and leaves /autoresearch to OMP."
      >
        <Switch
          on={state?.experimentsEnabled === true}
          onChange={(next) => void setExperimentsEnabled(next)}
          label="Experiments lab (beta)"
        />
      </Row>
      <Row
        title="Autoresearch bridge (beta)"
        hint="Arms new sessions with omp-ui's autoresearch bridge: the /autoresearch chip, live mode and goal for the Lab, and the propose_experiment interview tool. Off leaves OMP's own loop untouched; experiments launched from the Lab still run without the chip."
      >
        <Switch
          on={state?.autoresearchEnabled === true}
          onChange={(next) => void setAutoresearchEnabled(next)}
          label="Autoresearch bridge (beta)"
        />
      </Row>
      <Row
        title="Routines (experimental)"
        hint="Host-local schedules that start fresh background sessions with a compiled per-tool policy. Off by default; disabling suspends schedules without stopping live runs."
      >
        <Switch
          on={routinesOn}
          onChange={(next) => void setRoutinesEnabled(next)}
          label="Routines (experimental)"
        />
      </Row>
      {routinesOn && (
        <div className="ml-4 border-l border-line-soft pl-3">
          <Row title="Default routine spend warning (USD)" hint="Pinned per run through the session overlay. 0 disables the cap.">
            <CommitField
              kind="number"
              step="0.01"
              current={String(warnUsd)}
              label="Default routine spend warning (USD)"
              disabled={false}
              className="w-24"
              onCommit={(raw) => {
                const value = parseUsd(raw);
                if (value !== null) void setRoutineSpendDefaults(value, maxUsd);
              }}
            />
          </Row>
          <Row title="Default routine spend cap (USD)">
            <CommitField
              kind="number"
              step="0.01"
              current={String(maxUsd)}
              label="Default routine spend cap (USD)"
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
  return <p>Applies to sessions started afterwards; a running session keeps the bridges it launched with.</p>;
}
