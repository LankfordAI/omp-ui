import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Experimental: the app-global beta surface. Two independent
 * switches remain here after the #1052 split: `experimentsEnabled` gates the
 * Lab and the New experiment dialog (plus the /autoresearch start and lab
 * verbs) and `autoresearchEnabled` arms the autoresearch bridge on new
 * sessions. Each is the same flag the spawn path and surfaces read, so there
 * is one editor per flag. The council graduated to its own Settings page.
 */
export function ExperimentalPage() {
  const t = useT();
  const state = useStore((s) => s.state);
  const setExperimentsEnabled = useStore((s) => s.setExperimentsEnabled);
  const setAutoresearchEnabled = useStore((s) => s.setAutoresearchEnabled);
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
