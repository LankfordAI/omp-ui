import { useEffect } from "react";
import { useStore } from "../store";
import { clearShellTerm, ShellDrawer } from "./ShellDrawer";
import { Button, IconButton } from "./ui";

/**
 * The console as a composer drawer: a full-width login shell (issue #43; the
 * shell itself is issue #42) docked below the composer across the full tab
 * width. `ConsoleToggle` is the composer's button; `ConsoleDrawer` is the
 * drawer itself.
 */

/**
 * Tabs whose drawer has been opened at least once. After the first open the
 * drawer stays mounted (display:none when closed) so the shell's state —
 * cwd, env, running programs — survives the close (issue #42).
 */
const consoleOpened = new Set<string>();

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** The composer's console button. */
export function ConsoleToggle({ tabId }: { tabId: string }) {
  const toggleConsole = useStore((s) => s.toggleConsole);
  return (
    <IconButton label="toggle console (mod+j)" onClick={() => toggleConsole(tabId)}>
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" {...S} />
        <path d="M4.6 6.4l1.8 1.7-1.8 1.7M8.4 9.9h3" {...S} />
      </svg>
    </IconButton>
  );
}

export function ConsoleDrawer({ tabId }: { tabId: string }) {
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

  // The composer's own recipe: a card floating on the sunken strip, inset by
  // the same px-4 so the left edges line up. The terminal canvas paints the
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
            title="clear shell screen"
            onClick={() => clearShellTerm(tabId)}
          >
            clear
          </Button>
          <IconButton label="close console (mod+j)" onClick={() => toggleConsole(tabId)}>
            <svg viewBox="0 0 16 16" aria-hidden className="size-3">
              <path d="M4 4l8 8M12 4l-8 8" {...S} />
            </svg>
          </IconButton>
        </div>
      </div>
    </div>
  );
}
