import type { ReactNode } from "react";
import type { ProjectFace } from "../lib/repository-members";
import { ProjectMonogram } from "./ProjectMonogram";

/**
 * The session's project as its own line (prototype B): monogram, name, and
 * machine, with an optional trailing slot (the row's age). Chats show a
 * neutral chat mark; identity colour belongs to projects only (ADR-0004).
 * `dispatchedBy` adds the non-interactive ↳ marker naming the session whose
 * agent dispatched this one (#1226, ADR-0098).
 */
export function SessionProjectLine({
  project,
  nickname,
  trailing,
  dispatchedBy = null,
}: {
  project: ProjectFace | null;
  nickname: string | null;
  trailing?: ReactNode;
  dispatchedBy?: {
    tabId: string;
    title: string;
    project: ProjectFace | null;
    onHoverChange?: (over: boolean) => void;
  } | null;
}) {
  const machine = nickname ? `on ${nickname}` : null;
  return (
    <span data-session-project className="flex min-w-0 items-center gap-1.5 text-xs">
      {project !== null ? (
        <ProjectMonogram seed={project.seed} name={project.name} icon={project.icon} className="size-4 rounded text-[0.5rem]" />
      ) : (
        <ChatMark />
      )}
      <span className="min-w-0 truncate font-semibold text-ink-mid">{project?.name ?? "chat"}</span>
      {machine !== null && (
        <span title={machine} className="min-w-0 max-w-[50%] shrink-0 truncate text-ink-faint">
          {machine}
        </span>
      )}
      {dispatchedBy !== null && (
        <span
          role="img"
          data-dispatched-by={dispatchedBy.tabId}
          aria-label={`Dispatched by “${dispatchedBy.title}”`}
          title={`Dispatched by “${dispatchedBy.title}”`}
          onMouseEnter={() => dispatchedBy.onHoverChange?.(true)}
          onMouseLeave={() => dispatchedBy.onHoverChange?.(false)}
          className="flex shrink-0 items-center gap-0.5 text-ink-faint"
        >
          ↳
          {dispatchedBy.project !== null ? (
            <ProjectMonogram
              seed={dispatchedBy.project.seed}
              name={dispatchedBy.project.name}
              icon={dispatchedBy.project.icon}
              className="size-3.5 rounded-sm text-[0.45rem]"
            />
          ) : (
            <ChatMark />
          )}
        </span>
      )}
      {trailing !== undefined && <span className="ml-auto shrink-0">{trailing}</span>}
    </span>
  );
}

/** A chat's stand-in for the monogram: dashed neutral box, speech glyph. */
export function ChatMark() {
  return (
    <span
      data-chat-mark
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded border border-dashed border-line-strong text-ink-faint"
    >
      <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4.5h10v6H7l-3 2.5v-2.5H3z" />
      </svg>
    </span>
  );
}
