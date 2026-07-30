import type { ProjectGroup, SessionMode, SessionSummary } from "@omp-ui/core/types";
import { useStore } from "../store";

const LIVE_CHIP: Record<SessionSummary["live"], string> = {
  live: "bg-green-500",
  dormant: "bg-neutral-500",
  archived: "bg-amber-500",
  missing: "bg-red-500",
};

function formatModified(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function SessionRow({ s }: { s: SessionSummary }) {
  const openSession = useStore((st) => st.openSession);
  const switchMode = useStore((st) => st.switchMode);
  const prune = useStore((st) => st.prune);
  const missing = s.live === "missing";
  return (
    <div className="group flex items-center gap-2 px-2 py-1 text-xs hover:bg-neutral-800/60">
      <span className={`h-2 w-2 shrink-0 rounded-full ${LIVE_CHIP[s.live]}`} title={s.live} />
      <button
        className={`min-w-0 flex-1 truncate text-left ${missing ? "cursor-default text-neutral-600" : "hover:text-white"}`}
        onClick={() => {
          if (!missing) void openSession(s.tabId);
        }}
        title={s.title}
      >
        {s.title}
      </button>
      {s.status && <span className="shrink-0 text-[10px] text-neutral-500">{s.status}</span>}
      <button
        className="shrink-0 rounded border border-neutral-700 px-1 text-[10px] uppercase text-neutral-400 hover:border-neutral-500 disabled:opacity-30"
        title="switch mode"
        disabled={missing}
        onClick={() => void switchMode(s.tabId, s.mode === "pty" ? "rpc-ui" : "pty")}
      >
        {s.mode === "pty" ? "term" : "rpc"}
      </button>
      {missing ? (
        <button
          className="shrink-0 rounded bg-red-900/60 px-1 text-[10px] text-red-200 hover:bg-red-800"
          title="prune the record (files are kept)"
          onClick={() => void prune(s.tabId)}
        >
          prune
        </button>
      ) : (
        <span className="shrink-0 text-[10px] text-neutral-600">{formatModified(s.cachedModified)}</span>
      )}
    </div>
  );
}

function ProjectSection({ group }: { group: ProjectGroup }) {
  const newSession = useStore((st) => st.newSession);
  const removeProject = useStore((st) => st.removeProject);
  const toggleAdvisor = useStore((st) => st.toggleAdvisor);
  const { project } = group;
  return (
    <div className="border-b border-neutral-800/60 py-1">
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={project.path}>
          {project.name}
        </span>
        <label className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-500">
          <input
            type="checkbox"
            className="h-3 w-3"
            checked={project.advisor}
            onChange={(e) => void toggleAdvisor(project.path, e.target.checked)}
          />
          advisor
        </label>
        <button
          className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] hover:bg-neutral-700"
          onClick={() => void newSession(project.path)}
        >
          + session
        </button>
        <button
          className="shrink-0 rounded px-1 text-[10px] text-neutral-500 hover:text-red-400"
          title="remove project"
          onClick={() => void removeProject(project.path)}
        >
          ✕
        </button>
      </div>
      {group.sessions.map((s) => (
        <SessionRow key={s.tabId} s={s} />
      ))}
      {group.sessions.length === 0 && (
        <div className="px-2 pb-1 text-[10px] text-neutral-600">no sessions yet</div>
      )}
    </div>
  );
}

export function Sidebar() {
  const state = useStore((st) => st.state);
  const addProject = useStore((st) => st.addProject);
  const setDefaultMode = useStore((st) => st.setDefaultMode);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-sm font-semibold">omp-ui</span>
        <button
          className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
          onClick={() => void addProject()}
        >
          + project
        </button>
      </div>
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
        <span>new sessions:</span>
        <select
          className="rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          value={state?.defaultMode ?? "pty"}
          onChange={(e) => void setDefaultMode(e.target.value as SessionMode)}
        >
          <option value="pty">terminal</option>
          <option value="rpc-ui">native</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state?.projects.map((g) => <ProjectSection key={g.project.path} group={g} />)}
        {state && state.projects.length === 0 && (
          <div className="p-4 text-xs text-neutral-500">
            No projects yet — add one to start a session.
          </div>
        )}
      </div>
    </aside>
  );
}
