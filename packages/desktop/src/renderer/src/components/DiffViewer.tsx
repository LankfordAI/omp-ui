import type { DiffRow } from "../lib/omp-diff";

const ROW_CLASS: Record<DiffRow["kind"], string> = {
  add: "bg-green-950/60 text-green-300",
  del: "bg-red-950/60 text-red-300",
  ctx: "text-neutral-400",
  meta: "text-neutral-500 italic",
};

export function DiffViewer({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="overflow-x-auto rounded border border-neutral-800 font-mono text-[11px] leading-4">
      {rows.map((row, i) =>
        row.kind === "meta" ? (
          <div key={i} className={`px-2 py-0.5 ${ROW_CLASS.meta}`}>
            {row.text}
          </div>
        ) : (
          <div key={i} className={`flex px-2 ${ROW_CLASS[row.kind]}`}>
            <span className="w-10 shrink-0 select-none pr-2 text-right opacity-60">
              {row.lineNum}
            </span>
            <span className="whitespace-pre-wrap break-all">
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
              {row.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
