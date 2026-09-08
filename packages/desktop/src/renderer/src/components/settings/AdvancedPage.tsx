import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Button } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Advanced (issue #413): the diagnostic-bundle export entry point.
 * The dialog itself is mounted at the App root — this row only flips the
 * store flag, matching every other overlay opener.
 */
export function AdvancedPage() {
  const t = useT();
  const openDiagnosticsDialog = useStore((s) => s.openDiagnosticsDialog);
  return (
    <div className="px-4 py-3">
      <Row title={t("settings.advanced.bundleTitle")} hint={t("settings.advanced.bundleHint")}>
        <Button size="xs" onClick={openDiagnosticsDialog}>
          {t("settings.advanced.bundleAction")}
        </Button>
      </Row>
    </div>
  );
}
