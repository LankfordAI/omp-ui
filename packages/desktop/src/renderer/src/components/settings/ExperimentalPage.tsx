import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Experimental: the app-global beta surface. One switch gates the
 * Lab, the New experiment dialog, the autoresearch bridge, and the
 * code-review roster and /code-review command (#571, #739) — the same
 * `experimentsEnabled` the spawn path reads, so there is one flag and this is
 * its only editor.
 */
export function ExperimentalPage() {
  const t = useT();
  const state = useStore((s) => s.state);
  const setExperimentsEnabled = useStore((s) => s.setExperimentsEnabled);
  return (
    <div className="px-4 py-3">
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
    </div>
  );
}

export function ExperimentalFooter() {
  const t = useT();
  return <p>{t("settings.experimental.footer")}</p>;
}
