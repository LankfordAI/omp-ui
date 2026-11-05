import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { CouncilRosterEditor } from "../CouncilRoster";
import { Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Experimental: the app-global beta surface. Three independent
 * switches (#1052): `experimentsEnabled` gates the Lab and the New experiment
 * dialog (plus the /autoresearch start and lab verbs), `autoresearchEnabled`
 * arms the autoresearch bridge on new sessions, and `councilEnabled` gates the
 * council roster and /council command (#571, #1049). Each is the same flag the
 * spawn path and surfaces read, so there is one editor per flag. While the
 * council flag is on, the page also hosts the global roster editor (#1053):
 * `scopeCwd === null` means user scope on this host, the document every
 * project without an override falls back to.
 */
export function ExperimentalPage() {
  const t = useT();
  const state = useStore((s) => s.state);
  const setExperimentsEnabled = useStore((s) => s.setExperimentsEnabled);
  const setAutoresearchEnabled = useStore((s) => s.setAutoresearchEnabled);
  const setCouncilEnabled = useStore((s) => s.setCouncilEnabled);
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
      <Row
        title={t("settings.experimental.councilTitle")}
        hint={t("settings.experimental.councilHint")}
      >
        <Switch
          on={state?.councilEnabled === true}
          onChange={(next) => void setCouncilEnabled(next)}
          label={t("settings.experimental.councilTitle")}
        />
      </Row>
      {state?.councilEnabled === true && <CouncilRosterEditor scopeCwd={null} instanceId={null} />}
    </div>
  );
}

export function ExperimentalFooter() {
  const t = useT();
  return <p>{t("settings.experimental.footer")}</p>;
}
