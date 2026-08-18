import type { ProjectRecord } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useStore } from "../store";
import { Sheet } from "./ui";

/**
 * The compact project header's `⋯` bottom sheet (issue #205): the project's
 * name and full path, then session creation and removal. The desktop header's
 * open targets (VS Code / file manager) are deliberately absent — a compact
 * shell is usually a phone talking to a remote omp-ui, where "open on the
 * host" answers a question nobody asked.
 *
 * These are native buttons inside a dialog, deliberately not `role="menuitem"`:
 * `useOverlay` carves Escape out for menus (ui.tsx), and the Sheet's Tab trap
 * plus top-of-stack Escape are exactly the semantics a dialog wants.
 */

/** The sidebar menu-item convention, scaled up one size for touch; the
 *  coarse-pointer rule guarantees ≥44px height. */
const ACTION_ROW_CLASS =
  "w-full rounded-md px-2.5 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

export function ProjectActionsSheet({
  project,
  onClose,
  onActivate,
}: {
  /** `null` renders a closed Sheet. */
  project: Pick<ProjectRecord, "name" | "path"> | null;
  onClose: () => void;
  onActivate: () => void;
}) {
  const newSession = useStore((st) => st.newSession);
  const removeProject = useStore((st) => st.removeProject);
  const openMcpManager = useStore((st) => st.openMcpManager);
  const openWorktreeDialog = useStore((st) => st.openWorktreeDialog);

  return (
    <Sheet open={project !== null} placement="bottom" label={project?.name ?? ""} onClose={onClose}>
      {project !== null && (
        <div className="pb-2 pl-[max(1rem,var(--safe-left))] pr-[max(1rem,var(--safe-right))]">
          <p className="break-all px-2.5 pt-1 pb-2 font-mono text-[11px] text-ink-faint">
            {project.path}
          </p>
          <div className="flex flex-col">
            <button
              type="button"
              className={cn(ACTION_ROW_CLASS, "text-ink-mid")}
              onClick={() => {
                void newSession(project.path);
                onClose();
                onActivate();
              }}
            >
              New session
            </button>
            <button
              type="button"
              className={cn(ACTION_ROW_CLASS, "text-ink-mid")}
              onClick={() => {
                void newSession(project.path, "pty");
                onClose();
                onActivate();
              }}
            >
              New terminal session
            </button>
            <button
              type="button"
              className={cn(ACTION_ROW_CLASS, "text-ink-mid")}
              onClick={() => {
                openWorktreeDialog(project.path);
                onClose();
              }}
            >
              New worktree session…
            </button>
            <button
              type="button"
              className={cn(ACTION_ROW_CLASS, "text-ink-mid")}
              onClick={() => {
                openMcpManager(project.path);
                onClose();
              }}
            >
              MCP servers…
            </button>
            <button
              type="button"
              className={cn(ACTION_ROW_CLASS, "text-rose hover:text-rose focus-visible:text-rose")}
              // The store owns the confirm step; on confirm the stateChanged
              // broadcast drops the project, the sidebar's lookup returns
              // null, and this sheet closes itself. On cancel it stays open.
              onClick={() => void removeProject(project.path)}
            >
              Remove project…
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
