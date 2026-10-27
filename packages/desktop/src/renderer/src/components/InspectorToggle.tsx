import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { findRecord, useStore } from "../store";
import { inspectorBadgeTotal } from "./InspectorRail";
import { IconButton, IconInspect } from "./ui";

/** The title bar's inspector toggle (#941): opens/closes the rail pane; the badge total shows while closed. */
export function InspectorToggle({ tabId, className }: { tabId: string; className?: string }) {
  const t = useT();
  const open = useStore((s) => s.inspectorOpen);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const count = useStore((s) => inspectorBadgeTotal(s.rpc[tabId], findRecord(s.state, tabId)));
  const base = open ? t("hud.inspector.close") : t("hud.inspector.open");
  const label = !open && count > 0 ? t("rail.chrome.badgedTitle", { label: base, count }) : base;
  return (
    <span className={cn("relative shrink-0", className)}>
      <IconButton label={label} pressed={open} onClick={() => setInspectorOpen(!open)}>
        <IconInspect />
      </IconButton>
      {!open && count > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-1.5 -top-1 min-w-3 rounded-full bg-copper-wash px-0.5 text-center font-mono text-[9px] leading-3 text-copper"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </span>
  );
}
