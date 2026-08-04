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

  return (
    <div className={open ? "shrink-0 border-t border-line bg-sunken" : "hidden"}>
      <div className="flex h-8 items-center gap-2 px-3">
        <span className="flex-1" />
        <Button size="xs" variant="ghost" title="clear shell screen" onClick={() => clearShellTerm(tabId)}>
          clear
        </Button>
        <IconButton label="close console (mod+j)" onClick={() => toggleConsole(tabId)}>
          <svg viewBox="0 0 16 16" aria-hidden className="size-3">
            <path d="M4 4l8 8M12 4l-8 8" {...S} />
          </svg>
        </IconButton>
      </div>

      {/* Fixed height, no drag-resize: the app has no resize-handle
          convention, and a stable dock keeps the transcript from jumping. */}
      <div className="flex h-72 flex-col border-t border-line-soft px-3 py-2">
        <ShellDrawer tabId={tabId} visible={open} />
      </div>
    </div>
  );
}
