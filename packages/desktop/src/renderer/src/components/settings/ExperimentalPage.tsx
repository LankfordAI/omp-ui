import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Experimental: independent app-global gates. Artifact library
 * keeps the authoritative registry flag: switching never optimistically
 * grants a guest writer or reference permission. Lab and the autoresearch
 * bridge remain separately controlled.
 */
export function ExperimentalPage() {
  const t = useT();
  const state = useStore((s) => s.state);
  const setExperimentsEnabled = useStore((s) => s.setExperimentsEnabled);
  const setAutoresearchEnabled = useStore((s) => s.setAutoresearchEnabled);
  const setArtifactLibraryEnabled = useStore((s) => s.setArtifactLibraryEnabled);
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
    </div>
  );
}

export function ExperimentalFooter() {
  const t = useT();
  return <p>{t("settings.experimental.footer")}</p>;
}
