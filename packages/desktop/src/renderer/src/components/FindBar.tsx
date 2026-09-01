import { useEffect, useRef, type KeyboardEvent } from "react";
import { useT } from "../lib/i18n";
import { IconButton, IconClose } from "./ui";

/**
 * Find-within-session bar (issue #270): a hover-reveal pill riding on top of
 * the transcript, the same register as the "jump to latest" pill and the
 * console drawer controls.
 *
 * Fully controlled: the tab owns the query and match position and this bar
 * only reports intent (typing, Enter/Shift+Enter, Escape/✕). Enter and typing
 * never close the bar — only Escape or the ✕ does.
 */
export interface FindBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** 0-based index of the active match within the matched list; null when there is none. */
  matchIndex: number | null;
  matchCount: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

/* ------------------------------------------------------------------- icons */

function IconSearch() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="7" r="4" />
      <path d="M10.2 10.2 13 13" />
    </svg>
  );
}

/** Up arrow — previous match (mirrors the "jump to latest" glyph, flipped). */
function IconUp() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" />
    </svg>
  );
}

/** Down arrow — next match (the "jump to latest" glyph). */
function IconDown() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
    </svg>
  );
}

export function FindBar({ query, onQueryChange, matchIndex, matchCount, onPrev, onNext, onClose }: FindBarProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  // autoFocus covers the fresh-open case; the effect also select()s so a
  // restored query is replaced by typing instead of appended to.
  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Arrow keys stay free for text editing; only Enter navigates.
      event.preventDefault();
      if (event.shiftKey) onPrev();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  const readout =
    query.trim() === ""
      ? null
      : matchCount === 0
        ? t("transcript.findbar.noMatches")
        : t("transcript.findbar.position", { index: (matchIndex ?? 0) + 1, count: matchCount });

  return (
    <div className="find-bar absolute left-1/2 top-2 z-20 -translate-x-1/2 edge-lit flex items-center gap-1.5 rounded-full border border-line-strong bg-overlay px-3 py-1.5 text-[11px] backdrop-blur">
      <span className="shrink-0 text-ink-faint">
        <IconSearch />
      </span>
      <input
        ref={inputRef}
        type="text"
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("transcript.findbar.placeholder")}
        aria-label={t("transcript.findbar.placeholder")}
        spellCheck={false}
        className="find-bar-input min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
      />
      {readout !== null && <span className="shrink-0 font-mono text-ink-dim tabular-nums">{readout}</span>}
      <IconButton label={t("transcript.findbar.previous")} onClick={onPrev}>
        <IconUp />
      </IconButton>
      <IconButton label={t("transcript.findbar.next")} onClick={onNext}>
        <IconDown />
      </IconButton>
      <IconButton label={t("transcript.findbar.close")} onClick={onClose}>
        <IconClose className="size-3.5" />
      </IconButton>
    </div>
  );
}
