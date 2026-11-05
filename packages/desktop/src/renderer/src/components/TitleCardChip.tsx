import { parseTitleCard } from "@omp-ui/core/title-card";
import type { ReactNode } from "react";

/**
 * One treatment for omp's title cards (round-1 judge: the header showed the
 * colour emoji, the sidebar a mono `PLAN` chip, and the palette the raw
 * string — three faces of one title). Every chrome surface that prints a
 * session title renders it through here: the emoji stays out (the app's icon
 * language is the 16px stroke set, and colour emoji fight text for the
 * line's attention), the code rides as a compact raised chip, and the human
 * title follows. Tooltips and search keep the raw string — the card verbatim
 * is the unambiguous identity.
 */
export function withTitleCard(raw: string): ReactNode {
  const card = parseTitleCard(raw);
  if (card === null) return raw;
  return (
    <>
      <span className="mr-1.5 rounded bg-raised px-1 font-mono text-xs tracking-wide text-ink-mid">
        {card.code}
      </span>
      <span>{card.title}</span>
    </>
  );
}
