import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { ICON_STROKE, IconButton } from "../ui";

/** A phone: the device pane's HUD glyph, drawn like BrowserPaneToggle's globe. */
function IconPhone() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <rect x="4.2" y="1.8" width="7.6" height="12.4" rx="1.4" {...ICON_STROKE} />
      <path d="M7 12h2" {...ICON_STROKE} />
    </svg>
  );
}

/** The Session HUD's device pane button; pressed while the pane is open. */
export function DevicePaneToggle({ tabId, className }: { tabId: string; className?: string }) {
  const t = useT();
  const open = useStore((s) => s.rpc[tabId]?.devicePane.open === true);
  const toggleDevicePane = useStore((s) => s.toggleDevicePane);
  return (
    <IconButton
      label={open ? t("hud.actions.devicePaneClose") : t("hud.actions.devicePane")}
      pressed={open}
      className={className}
      onClick={() => toggleDevicePane(tabId)}
    >
      <IconPhone />
    </IconButton>
  );
}
