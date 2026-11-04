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
    // Fenced like every other sidebar boundary (#1039): the rule below keeps
    // the digest from reading as the head of the main list it sits atop.
    <div role="group" aria-label={t("sidebar.attention.heading", { n: entries.length })} className="space-y-1 border-b border-line pb-1.5">
      <div className="px-1.5 pt-1 pb-0.5 font-mono text-[10px] uppercase text-ink-faint">
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
            className="relative block w-full min-w-0 rounded-md px-3 py-2 text-left transition-colors hover:bg-raised/60"
          >
            <span
              aria-hidden
              className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", TONE_DOT[face.tone])}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={cn("font-mono text-[10px]", face.textClass)}>{t(face.labelKey)}</span>
              <span className="line-clamp-1 break-words text-[13.5px] leading-snug text-ink">
                {a.entry.session.title}
              </span>
              <span className="line-clamp-1 break-words text-xs text-ink-mid">
                {a.mark.snippet ?? t("sidebar.attention.fallback")}
              </span>
              <span className="truncate font-mono text-[10px] text-ink-faint">
                {projectLabel} · {relativeTime(new Date(a.mark.atMs).toISOString())}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
