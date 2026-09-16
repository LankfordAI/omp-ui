import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { ICON_STROKE, IconButton } from "../ui";

/** A globe: the browser pane's HUD glyph, drawn like App's IconInspect. */
function IconGlobe() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <circle cx="8" cy="8" r="5.6" {...ICON_STROKE} />
      <path d="M2.4 8h11.2M8 2.4c-2 2.1-2 9.1 0 11.2M8 2.4c2 2.1 2 9.1 0 11.2" {...ICON_STROKE} />
    </svg>
  );
}

/** The Session HUD's browser pane button; pressed while the pane is open. */
export function BrowserPaneToggle({ tabId, className }: { tabId: string; className?: string }) {
  const t = useT();
  const open = useStore((s) => s.rpc[tabId]?.browserPane.open === true);
  const toggleBrowserPane = useStore((s) => s.toggleBrowserPane);
  return (
    <IconButton
      label={open ? t("hud.actions.browserPaneClose") : t("hud.actions.browserPane")}
      pressed={open}
      className={className}
      onClick={() => toggleBrowserPane(tabId)}
    >
      <IconGlobe />
    </IconButton>
  );
}
