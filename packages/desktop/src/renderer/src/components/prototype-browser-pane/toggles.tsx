// PROTOTYPE (#527) — throwaway. Two of the three toggle candidates: the HUD
// IconButton (desktop + compact header) and the compact session-actions sheet
// button. The third (rail strip icon) lives inside InspectorRail; the palette
// action inside CommandPalette. All flip the same per-tab `open`.
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { Button, IconButton } from "../ui";
import { IconBrowserPaths } from "./pane";
import { toggleBrowserPane, useBrowserPane, usePrototypeVariant } from "./state";

export function BrowserPaneToggle({ tabId, className }: { tabId: string; className?: string }) {
  const variant = usePrototypeVariant();
  const pane = useBrowserPane(tabId);
  if (variant === null) return null;
  return (
    <span className="relative shrink-0">
      <IconButton
        label="browser pane (prototype)"
        className={cn(pane.open && "bg-raised text-ink", className)}
        onClick={() => toggleBrowserPane(tabId)}
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          <IconBrowserPaths />
        </svg>
      </IconButton>
      {pane.open && pane.agentConnected && (
        <span aria-hidden className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-signal" />
      )}
    </span>
  );
}

export function BrowserPaneSheetAction({ tabId, className }: { tabId: string; className?: string }) {
  const variant = usePrototypeVariant();
  const pane = useBrowserPane(tabId);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  if (variant === null) return null;
  return (
    <Button
      className={className}
      onClick={() => {
        toggleBrowserPane(tabId);
        closeCompactSurface();
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
        <IconBrowserPaths />
      </svg>
      {pane.open ? "hide browser" : "browser"}
    </Button>
  );
}
