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
 * Settings → Routines: the app-global routines gate (ADR-0100, #1244),
 * graduated out of Experimental. `routinesEnabled` stays opt-in — off by
 * default on every fresh registry, per ADR-0100 §1's security framing. The
 * page hosts the nested spend defaults (§5): each run pins them at fire
 * through the session overlay.
 */
export function RoutinesPage() {
  const state = useStore((s) => s.state);
  const setRoutinesEnabled = useStore((s) => s.setRoutinesEnabled);
  const setRoutineSpendDefaults = useStore((s) => s.setRoutineSpendDefaults);
  const routinesOn = state?.routinesEnabled === true;
  const warnUsd = state?.routineWarnCostUsd ?? 2;
  const maxUsd = state?.routineMaxCostUsd ?? 5;
  return (
    <div className="px-4 py-3">
      <Row title="Routines" hint="Host-local schedules that start fresh background sessions with a compiled per-tool policy. Off by default; disabling suspends schedules without stopping live runs.">
        <Switch
          on={routinesOn}
          onChange={(next) => void setRoutinesEnabled(next)}
          label="Routines"
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

export function RoutinesFooter() {
  return <p>Turning the switch off suspends schedules, run timers, and retention without stopping a live run or deleting routines.</p>;
}
