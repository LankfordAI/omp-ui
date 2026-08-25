import { useStore } from "../../store";
import type { Load } from "./types";

export function AboutPage({ load }: { load: Load }) {
  const appUpdate = useStore((s) => s.appUpdate);
  const ompUpdate = useStore((s) => s.ompUpdate);
  // These facts are otherwise only visible inside update cards that are
  // usually hidden — that is this page's whole reason to exist.
  const rows: Array<[string, string]> = [
    ["omp-ui version", appUpdate.currentVersion ?? "—"],
    ["omp version", ompUpdate.installedVersion ?? "—"],
    ["omp path", ompUpdate.installPath ?? "—"],
    [
      "omp config dir",
      load.status === "loaded" ? (load.snapshot.agentDir ?? "—") : "—",
    ],
  ];

  return (
    <div className="px-4 py-3">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="col-span-2 grid grid-cols-subgrid items-baseline"
          >
            <dt className="text-[11px] text-ink-faint">{label}</dt>
            <dd
              className="min-w-0 truncate font-mono text-[11px] text-ink-mid"
              title={value}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
