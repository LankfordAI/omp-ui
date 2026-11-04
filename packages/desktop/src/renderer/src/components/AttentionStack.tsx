import { relativeTime } from "../lib/format";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import type { AttentionEntry } from "../lib/sidebar-sessions";
import { useStore } from "../store";
import { TONE_DOT } from "./ui/tone";
import { SESSION_FACE } from "./SessionRow";

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
        const projectLabel = a.entry.projectName ?? t("sidebar.session.chat");
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
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={cn("text-xs", face.textClass)}>{t(face.labelKey)}</span>
              <span className="line-clamp-1 break-words text-sm leading-snug text-ink">
                {a.entry.session.title}
              </span>
              <span className="line-clamp-1 break-words text-xs text-ink-mid">
                {a.mark.snippet ?? t("sidebar.attention.fallback")}
              </span>
              <span className="truncate text-xs tabular-nums text-ink-faint">
                {projectLabel} · {relativeTime(new Date(a.mark.atMs).toISOString())}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
