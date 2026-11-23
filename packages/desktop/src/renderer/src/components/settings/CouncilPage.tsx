import { useStore } from "../../store";
import { CouncilRosterEditor } from "../CouncilRoster";
import { Switch } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Council: the app-global council gate (#1049), graduated out of
 * Experimental. `councilEnabled` gates the /council command and the council
 * bridge on new sessions; enabling it seeds an authored-empty global roster
 * from favorites (main owns the seed). While the flag is on, the page hosts
 * the global roster editor (#1053): `scopeCwd === null` means user scope on
 * this host, the document every project without an override falls back to.
 */
export function CouncilPage() {
  const state = useStore((s) => s.state);
  const setCouncilEnabled = useStore((s) => s.setCouncilEnabled);
  return (
    <div className="px-4 py-3">
      <Row title="Council" hint="Adds the /council command and the council bridge for new sessions, and grants per-session model roles. A project can override the global roster in its own settings under Council.">
        <Switch
          on={state?.councilEnabled === true}
          onChange={(next) => void setCouncilEnabled(next)}
          label="Council"
        />
      </Row>
      {state?.councilEnabled === true && <CouncilRosterEditor scopeCwd={null} instanceId={null} />}
    </div>
  );
}

export function CouncilFooter() {
  return <p>Applies to sessions started afterwards; a running session keeps the council it launched with.</p>;
}
