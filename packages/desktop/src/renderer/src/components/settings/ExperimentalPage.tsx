import { useStore } from "../../store";
import { Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Experimental: independent app-global gates. Artifact library
 * keeps the authoritative registry flag: switching never optimistically
 * grants a guest writer or reference permission. Lab and the autoresearch
 * bridge remain separately controlled. Routines graduated to its own Settings
 * page (#1244); its switch and spend defaults live under Settings → Routines.
 */
export function ExperimentalPage() {
  const state = useStore((s) => s.state);
  const setExperimentsEnabled = useStore((s) => s.setExperimentsEnabled);
  const setAutoresearchEnabled = useStore((s) => s.setAutoresearchEnabled);
  const setArtifactLibraryEnabled = useStore((s) => s.setArtifactLibraryEnabled);
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
    </div>
  );
}

export function ExperimentalFooter() {
  return <p>Applies to sessions started afterwards; a running session keeps the bridges it launched with.</p>;
}
