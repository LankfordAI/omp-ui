import { cn } from "../lib/cn";
import type { TodoPhase, TodoTask } from "../lib/rpc-types";
import { useT, type MessageKey } from "../lib/i18n";
import { useStore } from "../store";
import { Empty, Meter } from "./ui";

/**
 * The agent's plan. omp emits `todoPhases[] = [{ phase, tasks }]` — `tasks`,
 * never `items`, and `set_todos` echoes the same shape back, so a click here
 * rewrites the whole phase array rather than patching one row.
 */

const CYCLE: Record<string, string> = {
  pending: "in_progress",
  in_progress: "completed",
  completed: "pending",
};

/** omp's task statuses (docs/phase-2-rpc-ui.md § State). An unexpected token renders raw. */
const STATUS_LABEL: Record<string, MessageKey> = {
  pending: "todo.status.pending",
  in_progress: "todo.status.inProgress",
  completed: "todo.status.completed",
};

function TaskGlyph({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className="mt-px size-3.5 shrink-0 text-signal">
        <path
          d="M3.5 8.5L6.5 11.5L12.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="mt-1 grid size-3.5 shrink-0 place-items-center">
        <span className="active-halo size-2 rounded-full bg-copper" />
      </span>
    );
  }
  return (
    <span className="mt-1 grid size-3.5 shrink-0 place-items-center">
      <span className="size-2 rounded-full border border-current text-ink-faint" />
    </span>
  );
}

export function TodoPanel({ tabId }: { tabId: string }) {
  const phases = useStore((s) => s.rpc[tabId]?.todos) ?? [];
  const t = useT();
  const setTodos = useStore((s) => s.setTodos);

  if (phases.length === 0) {
    return <Empty title={t("todo.empty.title")} hint={t("todo.empty.hint")} />;
  }

  const cycle = (phaseIndex: number, taskIndex: number): void => {
    const next: TodoPhase[] = phases.map((phase, pi) =>
      pi !== phaseIndex
        ? phase
        : {
            ...phase,
            tasks: phase.tasks.map((task, ti): TodoTask =>
              ti !== taskIndex ? task : { ...task, status: CYCLE[task.status] ?? "in_progress" },
            ),
          },
    );
    void setTodos(tabId, next);
  };

  return (
    <div className="space-y-3 px-3 py-2.5">
      {phases.map((phase, pi) => {
        const tasks = phase.tasks ?? [];
        const done = tasks.filter((t) => t.status === "completed").length;
        const progress = t("todo.panel.progress", { done, total: tasks.length });
        return (
          <section key={pi}>
            <div className="mb-1 flex items-baseline gap-2">
              <h3 className="min-w-0 flex-1 truncate font-display text-[12px] text-ink">
                {phase.phase ?? t("todo.panel.phase", { n: pi + 1 })}
              </h3>
              <span
                className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint"
                title={progress}
              >
                {done}/{tasks.length}
              </span>
            </div>
            <Meter
              fraction={tasks.length > 0 ? done / tasks.length : 0}
              className="mb-1.5"
              title={progress}
            />
            <ul className="space-y-0.5">
              {tasks.map((task, ti) => {
                const label = STATUS_LABEL[task.status];
                return (
                  <li key={ti} className="animate-slide-in">
                    <button
                      type="button"
                      onClick={() => cycle(pi, ti)}
                      title={t("todo.panel.advance", { status: label ? t(label) : task.status })}
                      className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-hover"
                    >
                      <TaskGlyph status={task.status} />
                      <span
                        className={cn(
                          "min-w-0 flex-1 text-[11px] leading-snug",
                          task.status === "completed"
                            ? "text-ink-faint line-through"
                            : task.status === "in_progress"
                              ? "text-ink"
                              : "text-ink-mid",
                        )}
                      >
                        {task.content}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
