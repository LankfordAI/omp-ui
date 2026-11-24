import type { MouseEvent as ReactMouseEvent } from "react";
import { relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import type { AttentionEntry } from "../lib/sidebar-sessions";
import { useStore } from "../store";
import { IconClose, IconButton } from "./ui";
import { TONE_DOT, type Tone } from "./ui/tone";
import { SESSION_FACE } from "./SessionRow";
import { SessionProjectLine } from "./SessionProjectLine";
import { withTitleCard } from "./TitleCardChip";
import { DispatchTether } from "./DispatchTether";

const REMINDER_FACE: { tone: Tone; label: string; textClass: string } = {
  tone: "iris",
  label: "reminder",
  textClass: "text-iris",
};

/**
 * The "Needs attention" stack (issues #1037, #1323): cards for sessions with an
 * unseen reply, a routine Approval card, or an expired timed-snooze reminder,
 * mounted above the session list. The heading is a label, not a toggle: the
 * stack has no collapsed state to remember.
 */
export function AttentionStack({
  entries,
  onActivate,
  onReminderContextMenu,
}: {
  entries: AttentionEntry[];
  onActivate?: () => void;
  onReminderContextMenu?: (entry: AttentionEntry["entry"], event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const openSession = useStore((st) => st.openSession);
  const setSessionSnoozed = useStore((st) => st.setSessionSnoozed);
  if (entries.length === 0) return null;
  return (
    // Fenced as its own surface (#1039): the hairline rule alone still read
    // as part of the list. The raised panel + full border separate the digest
    // from the rows it sits above; card hover rides the theme's hover tone so
    // it stays visible on the raised surface.
    <div
      role="group"
      aria-label={`Needs attention (${entries.length})`}
      className="mb-1.5 space-y-0.5 rounded-md border border-line bg-raised/60 p-1"
    >
      <div className="chrome-label px-2 pt-1.5 pb-1 text-ink-dim">
        {`Needs attention (${entries.length})`}
      </div>
      {entries.map((a) => {
        const face = a.state === "reminder" ? REMINDER_FACE : SESSION_FACE[a.state];
        const { session, dispatch } = a.entry;
        const isReminder = a.state === "reminder";
        return (
          // The dispatch tether (#1226) is the card's sibling, never nested in its button.
          <div
            key={`${a.entry.instanceId ?? "local"}:${session.tabId}`}
            className="group/card relative"
            onContextMenu={
              isReminder && onReminderContextMenu !== undefined
                ? (event) => onReminderContextMenu(a.entry, event)
                : undefined
            }
          >
            <button
              type="button"
              onClick={() => {
                void openSession(session.tabId);
                onActivate?.();
              }}
              className={cn(
                "relative block w-full min-w-0 rounded-md px-3 py-2 text-left transition-colors hover:bg-hover/50",
                isReminder && "pr-8",
              )}
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
                  nickname={a.entry.nickname}
                  dispatchedBy={
                    dispatch.parent === null
                      ? null
                      : {
                          tabId: dispatch.parent.session.tabId,
                          title: dispatch.parent.session.title,
                          project: dispatch.parent.project,
                        }
                  }
                  trailing={
                    <span className="tabular-nums text-ink-faint">{relativeTime(new Date(a.mark.atMs).toISOString())}</span>
                  }
                />
                <span className="line-clamp-1 break-words text-sm leading-snug text-ink">
                  {withTitleCard(a.entry.session.title)}
                </span>
                <span className="line-clamp-1 break-words text-xs text-ink-dim">
                  <span className={face.textClass}>{face.label}</span>
                  {isReminder ? (
                    <>
                      {" · "}
                      {session.live === "live" ? "Snooze ended" : "Snooze ended — click to resume"}
                    </>
                  ) : a.state === "awaiting-answer" && a.mark.snippet === null ? (
                    <>
                      {" · "}
                      Approval required
                    </>
                  ) : (
                    <>
                      {" · "}
                      <span className="text-ink-faint">reply</span>
                      {" · "}
                      {a.mark.snippet ?? "The agent posted a new reply."}
                    </>
                  )}
                </span>
              </span>
            </button>
            {isReminder && (
              <IconButton
                label="Dismiss reminder"
                onClick={(event) => {
                  event.stopPropagation();
                  void setSessionSnoozed(session.tabId, false);
                }}
                className="absolute top-1.5 right-1.5 size-6 opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100"
              >
                <IconClose className="size-3" />
              </IconButton>
            )}
            {dispatch.children.length > 0 && (
              <DispatchTether
                parentTabId={session.tabId}
                parentTitle={session.title}
                children={dispatch.children}
                onActivate={onActivate}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
