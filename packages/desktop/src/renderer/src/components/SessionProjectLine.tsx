import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import type { ProjectFace } from "../lib/repository-members";
import { ProjectMonogram } from "./ProjectMonogram";

/**
 * The session's project as its own line (prototype B): monogram, name, and
 * machine, with an optional trailing slot (the row's age). Chats show a
 * neutral chat mark; identity colour belongs to projects only (ADR-0004).
 */
export function SessionProjectLine({
  project,
  nickname,
  trailing,
}: {
  project: ProjectFace | null;
  nickname: string | null;
  trailing?: ReactNode;
}) {
  const t = useT();
  const machine = nickname ? t("sidebar.session.machine", { machine: nickname }) : null;
  return (
    <span data-session-project className="flex min-w-0 items-center gap-1.5 text-xs">
      {project !== null ? (
        <ProjectMonogram seed={project.seed} name={project.name} icon={project.icon} className="size-4 rounded text-[0.5rem]" />
      ) : (
        <ChatMark />
      )}
      <span className="min-w-0 truncate font-semibold text-ink-mid">{project?.name ?? t("sidebar.session.chat")}</span>
      {machine !== null && (
        <span title={machine} className="min-w-0 max-w-[50%] shrink-0 truncate text-ink-faint">
          {machine}
        </span>
      )}
      {trailing !== undefined && <span className="ml-auto shrink-0">{trailing}</span>}
    </span>
  );
}

/** A chat's stand-in for the monogram: dashed neutral box, speech glyph. */
function ChatMark() {
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
