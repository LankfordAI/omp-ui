import { useEffect, useState } from "react";
import { ARTIFACT_LIMITS } from "@omp-ui/core/artifacts";
import { backend } from "../../backend";
import { formatBytes } from "../../lib/format";
import { useStore } from "../../store";
import { Button, Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Artifacts: graduated out of Experimental (#1307).
 * `artifactLibraryEnabled` keeps the authoritative registry flag — switching
 * never optimistically grants a guest writer or reference permission.
 */
export function ArtifactsPage() {
  const state = useStore((s) => s.state);
  const setArtifactLibraryEnabled = useStore((s) => s.setArtifactLibraryEnabled);
  const setHtmlArtifactScripts = useStore((s) => s.setHtmlArtifactScripts);
  const closeSettings = useStore((s) => s.closeSettings);
  const openArtifacts = useStore((s) => s.openArtifacts);
  const libraryOn = state?.artifactLibraryEnabled === true;
  const scriptsOn = state?.htmlArtifactScripts ?? true;

  const [summary, setSummary] = useState<{ totalCount: number; libraryBytesUsed: number } | null>(null);

  useEffect(() => {
    if (!libraryOn) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    void backend.artifactList({ limit: 1 }).then(
      (result) => {
        if (!cancelled) {
          setSummary({
            totalCount: result.totalCount,
            libraryBytesUsed: result.libraryBytesUsed,
          });
        }
      },
      () => {
        if (!cancelled) setSummary(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [libraryOn]);

  return (
    <div className="px-4 py-3">
      <Row
        title="Artifact library"
        hint="Keep session-authored artifacts and their saved data on this machine. Default on; disabling hides the library without deleting kept data."
      >
        <Switch
          on={libraryOn}
          onChange={(on) => void setArtifactLibraryEnabled(on)}
          label="Artifact library"
        />
      </Row>
      <Row
        title="Run scripts in HTML artifacts"
        hint="Interactive documents the agent renders inline in the transcript run their scripts sandboxed, with no network, storage, popups, forms, or navigation. Off shows every artifact as a static document. Remote browser clients always show artifacts static."
      >
        <Switch
          on={scriptsOn}
          onChange={(next) => void setHtmlArtifactScripts(next)}
          label="Run scripts in HTML artifacts"
        />
      </Row>
      {libraryOn && (
        <Row
          title="Local library"
          hint={
            summary
              ? `${summary.totalCount} kept · ${formatBytes(summary.libraryBytesUsed)} of ${formatBytes(ARTIFACT_LIMITS.libraryBytes)}`
              : "Host-local SQLite storage on this machine."
          }
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              closeSettings();
              openArtifacts();
            }}
          >
            Open Artifacts
          </Button>
        </Row>
      )}
    </div>
  );
}

export function ArtifactsFooter() {
  return (
    <p>
      Kept artifacts stay host-local on this machine. Turning the library off revokes live guest writers and hides the library without deleting saved data.
    </p>
  );
}
