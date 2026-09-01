import { useEffect } from "react";
import { backend } from "../backend";
import { IS_WINDOWS } from "../lib/platform";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { ShellDrawer } from "./ShellDrawer";
import { Button, ICON_STROKE, IconButton, IconClose } from "./ui";

/**
 * The console as a Session HUD-controlled drawer: a full-width login shell
 * (issue #43; the shell itself is issue #42) docked below the composer across
 * the full tab width.
 */

/**
 * Tabs whose drawer has been opened at least once. After the first open the
 * drawer stays mounted (display:none when closed) so the shell's state —
 * cwd, env, running programs — survives the close (issue #42).
 */
const consoleOpened = new Set<string>();

/** The Session HUD's console button. */
export function ConsoleToggle({ tabId, className }: { tabId: string; className?: string }) {
  const toggleConsole = useStore((s) => s.toggleConsole);
  const t = useT();
  return (
    <IconButton label={t("console.toggle.label")} className={className} onClick={() => toggleConsole(tabId)}>
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" {...ICON_STROKE} />
        <path d="M4.6 6.4l1.8 1.7-1.8 1.7M8.4 9.9h3" {...ICON_STROKE} />
      </svg>
    </IconButton>
  );
}

export function ConsoleDrawer({ tabId }: { tabId: string }) {
  const t = useT();
  const open = useStore((s) => s.consoleOpen[tabId] ?? false);
  const toggleConsole = useStore((s) => s.toggleConsole);

  // After the first open the drawer stays mounted — `hidden` (display:none)
  // keeps the xterm instance and its writer registration alive so a closed
  // drawer does not kill running shell programs (same survival strategy
  // App.tsx uses for hidden tabs).
  useEffect(() => {
    if (open) consoleOpened.add(tabId);
  }, [open, tabId]);
  if (!open && !consoleOpened.has(tabId)) return null;

  // The console recipe: a card floating on the sunken strip, inset by the
  // same px-4 so the left edges line up. The terminal canvas paints the
  // `surface` token, so card and canvas merge into one bordered well; the
  // controls ride as a hover-reveal pill instead of a header row.
  return (
    <div className={open ? "console-drawer shrink-0 border-t border-line bg-sunken px-4 pb-3 pt-2" : "hidden"}>
      {/* Fixed height, no drag-resize: the app has no resize-handle
          convention, and a stable dock keeps the transcript from jumping. */}
      <div className="console-drawer-body group relative flex h-72 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        <ShellDrawer tabId={tabId} visible={open} />
        <div className="console-drawer-controls absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-full border border-line bg-overlay/85 px-1.5 py-0.5 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            size="xs"
            variant="ghost"
            title={t("console.drawer.clearTitle")}
            // `cls` is accepted by cmd and PowerShell alike (it is a built-in
            // Clear-Host alias there), while `clear` is the Unix spelling —
            // sending the wrong one makes the shell reject it (issue #166).
            onClick={() => backend.shellWrite(tabId, IS_WINDOWS ? "cls\n" : "clear\n")}
          >
            {t("console.drawer.clear")}
          </Button>
          <IconButton label={t("console.drawer.closeLabel")} onClick={() => toggleConsole(tabId)}>
            <IconClose className="size-3" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
