// PROTOTYPE (#753): throwaway.
// Pieces every surface shares: the note glyph, the action chip, and the
// "Open in Obsidian" button. The real open channel belongs to #758
// (openExternalSafe and isSafeHref drop obsidian: today), so the button copies
// the URI and keeps it in its title.
import { useEffect, useRef, useState } from "react";
import { copyFallback } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { Button, Chip, ICON_STROKE, IconButton, type Tone } from "../ui";
import type { VaultAction } from "./fixtures";

export function NoteGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", className)} {...ICON_STROKE}>
      <path d="M3.5 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H5a1.5 1.5 0 0 1-1.5-1.5zM3.5 12a1.5 1.5 0 0 1 1.5-1.5h7.5M6 5.5h4" />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" {...ICON_STROKE}>
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

const ACTION: Record<VaultAction, { label: string; tone: Tone }> = {
  create: { label: "Created", tone: "signal" },
  append: { label: "Appended", tone: "neutral" },
  edit: { label: "Edited", tone: "copper" },
};

export function ActionChip({ action }: { action: VaultAction }) {
  const { label, tone } = ACTION[action];
  return <Chip tone={tone}>{label}</Chip>;
}

/**
 * Copies `uri` on click and flips to "Link copied" for 2 s. When the clipboard
 * refuses, the URI shows inline in a selectable mono line instead.
 */
export function OpenInObsidian({
  uri,
  iconOnly = false,
  className,
}: {
  uri: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const settle = (next: "copied" | "failed"): void => {
    setState(next);
    window.clearTimeout(timer.current);
    if (next === "copied") timer.current = window.setTimeout(() => setState("idle"), 2000);
  };
  const copy = (): void => {
    const write = navigator.clipboard?.writeText;
    if (typeof write !== "function") {
      settle(copyFallback(uri) ? "copied" : "failed");
      return;
    }
    void navigator.clipboard.writeText(uri).then(
      () => settle("copied"),
      () => settle(copyFallback(uri) ? "copied" : "failed"),
    );
  };
  const label = state === "copied" ? "Link copied" : "Open in Obsidian";
  return (
    <span className={cn("inline-flex min-w-0 shrink-0 flex-col items-end gap-1", className)}>
      {iconOnly ? (
        <span title={uri} className="inline-flex">
          <IconButton label={label} onClick={(e) => { e.stopPropagation(); copy(); }} className={state === "copied" ? "text-signal" : undefined}>
            <ExternalGlyph />
          </IconButton>
        </span>
      ) : (
        <span
          title={uri}
          className="inline-flex"
          onClick={(e) => e.stopPropagation()}
        >
          <Button size="xs" tone={state === "copied" ? "signal" : "neutral"} onClick={copy}>
            <ExternalGlyph />
            {label}
          </Button>
        </span>
      )}
      {state === "failed" && (
        <span data-selectable className="max-w-full select-all break-all font-mono text-[10px] text-ink-mid">
          {uri}
        </span>
      )}
    </span>
  );
}
