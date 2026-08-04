import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { BashDrawer } from "./BashDrawer";
import { Button, Empty, IconButton, Label } from "./ui";

/**
 * The console as a composer drawer (issue #33): the command-output stream and
 * the bash shell that used to live in the inspector rail, now docked below the
 * composer across the full tab width. `ConsoleToggle` is the composer's
 * button; `ConsoleDrawer` is the drawer itself.
 */

/**
 * Per-tab "seen" watermarks for the toggle's unread dot. View bookkeeping,
 * not session state, so it must not round-trip through the store — but it must
 * also survive a tab switch and back, which component state cannot.
 */
const consoleSeen = new Map<string, number>();

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** The composer's console button; a copper dot marks output arrived while closed. */
export function ConsoleToggle({ tabId }: { tabId: string }) {
  const open = useStore((s) => s.consoleOpen[tabId] ?? false);
  const total = useStore(
    (s) => (s.rpc[tabId]?.commandOutput.length ?? 0) + (s.rpc[tabId]?.bashLines.length ?? 0),
  );
  const toggleConsole = useStore((s) => s.toggleConsole);

  // While open, "seen" tracks continuously, so the dot re-arms only on output
  // that arrives after the drawer closes.
  useEffect(() => {
    if (open) consoleSeen.set(tabId, total);
  }, [open, total, tabId]);

  // A dot, not a count: `command_output` frames append to both streams in the
  // store, so any number derived from their lengths double-counts.
  const unread = !open && total > (consoleSeen.get(tabId) ?? 0);

  return (
    <span className="relative">
      <IconButton label="toggle console (mod+j)" onClick={() => toggleConsole(tabId)}>
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" {...S} />
          <path d="M4.6 6.4l1.8 1.7-1.8 1.7M8.4 9.9h3" {...S} />
        </svg>
      </IconButton>
      {unread && (
        <span className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-copper" />
      )}
    </span>
  );
}

export function ConsoleDrawer({ tabId }: { tabId: string }) {
  const open = useStore((s) => s.consoleOpen[tabId] ?? false);
  const output = useStore((s) => s.rpc[tabId]?.commandOutput) ?? [];
  const clearCommandOutput = useStore((s) => s.clearCommandOutput);
  const clearBash = useStore((s) => s.clearBash);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [output.length]);

  if (!open) return null;

  return (
    <div className="shrink-0 border-t border-line bg-sunken">
      <div className="flex h-8 items-center gap-2 px-3">
        <Label>console</Label>
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          title="clear command and bash output"
          onClick={() => {
            clearCommandOutput(tabId);
            clearBash(tabId);
          }}
        >
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
      <div className="grid h-72 grid-cols-2 gap-2 border-t border-line-soft px-3 py-2">
        <div className="flex min-h-0 min-w-0 flex-col">
          <Label className="mb-1 shrink-0">command output</Label>
          {output.length === 0 ? (
            <Empty
              title="No command output"
              hint="Slash commands like /stats print their reply here."
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-void px-2 py-1.5">
              {output.map((line, i) => (
                <pre
                  key={i}
                  data-selectable
                  className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink-mid"
                >
                  {line}
                </pre>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          <Label className="mb-1 shrink-0">bash</Label>
          <BashDrawer tabId={tabId} />
        </div>
      </div>
    </div>
  );
}
