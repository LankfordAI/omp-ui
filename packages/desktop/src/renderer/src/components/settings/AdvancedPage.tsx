import { useStore } from "../../store";
import { Button } from "../ui";
import { Row } from "./rows";

/**
 * Settings → Advanced (issue #413): the diagnostic-bundle export entry point.
 * The dialog itself is mounted at the App root — this row only flips the
 * store flag, matching every other overlay opener.
 */
export function AdvancedPage() {
  const openDiagnosticsDialog = useStore((s) => s.openDiagnosticsDialog);
  const openBrowserPaneClearDialog = useStore((s) => s.openBrowserPaneClearDialog);
  return (
    <div className="px-4 py-3">
      <Row title="Diagnostic bundle" hint="Packages logs, lifecycle breadcrumbs, versions, and registry state into one zip for bug reports. Provider keys and remote credentials are never included; transcripts are excluded unless you tick the option.">
        <Button size="xs" onClick={openDiagnosticsDialog}>
          Export diagnostic bundle…
        </Button>
      </Row>
      <Row title="Browser pane data" hint="Pages opened in the browser pane keep cookies, storage and cache in their own profile across restarts and sessions. Clearing signs you out of every site you logged into there; no other data is touched.">
        <Button size="xs" onClick={openBrowserPaneClearDialog}>
          Clear browser pane data…
        </Button>
      </Row>
    </div>
  );
}
