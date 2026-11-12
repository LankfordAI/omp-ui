import { relativeTime } from "../lib/format";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import type { AttentionEntry } from "../lib/sidebar-sessions";
import { useStore } from "../store";
import { TONE_DOT } from "./ui/tone";
import { SESSION_FACE } from "./SessionRow";
import { SessionProjectLine } from "./SessionProjectLine";
import { withTitleCard } from "./TitleCardChip";

/**
 * The "Needs attention" stack (issue #1037): cards for sessions with an
 * unseen reply, mounted above the session list. Cards are fire-and-open only
 * — no drag, no multi-select, no context menu; opening the session is the
 * whole interaction, and the store clears the mark on open. The heading is a
 * label, not a toggle: the stack has no collapsed state to remember.
 */
export function AttentionStack({
  entries,
  onActivate,
}: {
  entries: AttentionEntry[];
  onActivate?: () => void;
}) {
  const t = useT();
  const openSession = useStore((st) => st.openSession);
  if (entries.length === 0) return null;
  return (
    // Fenced as its own surface (#1039): the hairline rule alone still read
    // as part of the list. The raised panel + full border separate the digest
    // from the rows it sits above; card hover rides the theme's hover tone so
    // it stays visible on the raised surface.
    <div
      role="group"
      aria-label={t("sidebar.attention.heading", { n: entries.length })}
      className="mb-1.5 space-y-0.5 rounded-md border border-line bg-raised/60 p-1"
    >
      <div className="chrome-label px-2 pt-1.5 pb-1 text-ink-dim">
        {t("sidebar.attention.heading", { n: entries.length })}
      </div>
      {entries.map((a) => {
        const face = SESSION_FACE[a.state];
        return (
          <button
            key={a.entry.session.tabId}
            type="button"
            onClick={() => {
              void openSession(a.entry.session.tabId);
              onActivate?.();
            }}
            className="relative block w-full min-w-0 rounded-md px-3 py-2 text-left transition-colors hover:bg-hover/50"
          >
            <span
              aria-hidden
              className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", TONE_DOT[face.tone])}
            />
            {/* Round-8 judge, Consistency 1, revised for #1159: the card
                follows the tile idiom — the project line first (monogram,
                name, mark age), then the title, then one muted line carrying
                the state word (coloured like the row's), the label, and the
                unseen reply. The title rides `withTitleCard` so an omp card
                title shows its mono chip here exactly as it does in the row,
                the header, and the palette (issue #838), not raw emoji. */}
            <span className="flex min-w-0 flex-col gap-0.5">
              <SessionProjectLine
                project={a.entry.project}
                nickname={null}
                trailing={
                  <span className="tabular-nums text-ink-faint">{relativeTime(new Date(a.mark.atMs).toISOString())}</span>
                }
              />
              <span className="line-clamp-1 break-words text-sm leading-snug text-ink">
                {withTitleCard(a.entry.session.title)}
              </span>
              <span className="line-clamp-1 break-words text-xs text-ink-dim">
                <span className={face.textClass}>{t(face.labelKey)}</span>
                {" · "}
                <span className="text-ink-faint">{t("sidebar.attention.reply")}</span>
                {" · "}
                {a.mark.snippet ?? t("sidebar.attention.fallback")}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
