import { field, strField } from "../lib/fields";
import { useStore } from "../store";

function TodoItem({ item }: { item: unknown }) {
  const label =
    strField(item, "content") ?? strField(item, "text") ?? strField(item, "task") ?? "";
  const status = strField(item, "status") ?? "";
  const done = status === "completed" || status === "done";
  const active = status === "in_progress";
  return (
    <li className="flex items-start gap-1.5 text-[11px]">
      <span className={done ? "text-green-500" : active ? "text-amber-400" : "text-neutral-600"}>
        {done ? "✓" : active ? "▸" : "○"}
      </span>
      <span className={done ? "text-neutral-500 line-through" : "text-neutral-300"}>{label}</span>
    </li>
  );
}

export function TodoPanel({ tabId }: { tabId: string }) {
  const todos = useStore((s) => s.rpc[tabId]?.todos);
  const phases = Array.isArray(todos) ? todos : [];
  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l border-neutral-800 px-2 py-2">
      <div className="mb-1 text-[10px] font-semibold uppercase text-neutral-500">todos</div>
      {phases.length === 0 && <p className="text-[11px] text-neutral-600">no todos</p>}
      {phases.map((phase, i) => {
        const title = strField(phase, "phase") ?? strField(phase, "name") ?? `phase ${i + 1}`;
        const items = field(phase, "items");
        return (
          <div key={i} className="mb-2">
            <div className="text-[11px] font-semibold text-neutral-300">{title}</div>
            <ul className="mt-0.5 space-y-0.5">
              {Array.isArray(items) && items.map((item, j) => <TodoItem key={j} item={item} />)}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}
