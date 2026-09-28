import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { StatsModelRow, StatsOverview, StatsProjectRow, StatsSessionRow } from "@omp-ui/core/types";
import { backend } from "../../backend";
import { useT } from "../../lib/i18n";
import { compactNum, exactNum, formatCost, relativeTime } from "../../lib/format";
import { useLoad } from "../../lib/load";
import { useStore } from "../../store";
import type { StatsView } from "../../store/types";
import { Button, IconButton, IconClose, IconRefresh, Label } from "../ui";

/**
 * The Stats view (CONTEXT.md, issue #668): omp's cross-session usage —
 * totals, per-day and per-model rollups, Projects, and per-session cost —
 * read straight from omp's stats.db through the read-only core reader
 * (ADR-0037). It takes the main pane in place of the tabs, exactly like the
 * Lab, and reads only: the database belongs to omp.
 */

const RANGES: readonly (number | null)[] = [null, 30, 7];

/** Last loaded payload, kept while the next read is in flight. */
function useKeptStats(view: StatsView) {
  const read = useCallback(() => backend.statsOverview(view.rangeDays), [view.rangeDays]);
  const { load, retry } = useLoad(read);
  const kept = useRef<StatsOverview | null>(null);
  if (load.status === "loaded") kept.current = load.value;
  return { load, retry, value: kept.current };
}

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-ink">{value}</span>
    </div>
  );
}

/* -------------------------------------------------------------- sorting */

interface Sort {
  column: string;
  desc: boolean;
}

/** One table's local sort; the DTO's own order is the no-sort state. */
function useSort() {
  const [sort, setSort] = useState<Sort | null>(null);
  const toggle = (column: string): void => {
    setSort((prev) => (prev?.column === column ? { column, desc: !prev.desc } : { column, desc: true }));
  };
  return { sort, toggle };
}
/** A row's plain column value for sorting: numbers compare, the rest lexically. */
function cell(row: object, column: string): string | number {
  const value = (row as Record<string, unknown>)[column];
  return typeof value === "number" ? value : String(value ?? "");
}

function sortRows<T>(rows: readonly T[], sort: Sort | null, value: (row: T, column: string) => string | number): T[] {
  if (sort === null) return [...rows];
  const { column, desc } = sort;
  return [...rows].sort((a, b) => {
    const x = value(a, column);
    const y = value(b, column);
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return desc ? -cmp : cmp;
  });
}

function Th({
  label,
  column,
  sort,
  toggle,
  align = "left",
}: {
  label: string;
  column: string;
  sort: Sort | null;
  toggle: (column: string) => void;
  align?: "left" | "right";
}) {
  return (
    <th className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => toggle(column)}
        className="text-[10px] uppercase tracking-[0.08em] text-ink-faint hover:text-ink-mid"
      >
        {label}
        {sort?.column === column ? (sort.desc ? " ▾" : " ▴") : ""}
      </button>
    </th>
  );
}

const TD_RIGHT = "py-0.5 text-right font-mono text-[11px] tabular-nums text-ink-mid";
const TD_LEFT = "min-w-0 py-0.5 text-[11px] text-ink-mid";

/* -------------------------------------------------------------- sections */

function TotalsStrip({ stats }: { stats: StatsOverview }) {
  const t = useT();
  const totals = stats.totals;
  return (
    <section className="border-b border-line-soft px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Stat
          label={t("stats.col.cost")}
          value={formatCost(totals.cost)}
          title={`${totals.cost}`}
        />
        <Stat label={t("stats.col.tokens")} value={compactNum(totals.totalTokens)} title={exactNum(totals.totalTokens)} />
        <Stat
          label={t("stats.col.requests")}
          value={
            <>
              {exactNum(totals.requests)}
              {totals.failed > 0 && (
                <span className="ml-1.5 text-[10px] text-ink-faint">{t("stats.totals.failed", { n: totals.failed })}</span>
              )}
            </>
          }
        />
        <Stat label={t("stats.col.premium")} value={exactNum(totals.premiumRequests)} />
        {totals.unpricedRequests > 0 && (
          <Stat label={t("stats.totals.unpriced")} value={exactNum(totals.unpricedRequests)} />
        )}
      </div>
      {totals.lastTs !== null && (
        <div className="mt-1 text-[10px] text-ink-faint">
          {t("stats.totals.through", { time: relativeTime(new Date(totals.lastTs).toISOString()) })}
        </div>
      )}
    </section>
  );
}

function DaysSection({ stats }: { stats: StatsOverview }) {
  const t = useT();
  if (stats.days.length === 0) {
    return (
      <Section title={t("stats.section.days")}>
        <p className="text-[11px] text-ink-faint">{t("stats.empty.noRows")}</p>
      </Section>
    );
  }
  const maxCost = Math.max(...stats.days.map((day) => day.cost));
  return (
    <Section title={t("stats.section.days")}>
      <div className="flex h-24 items-end gap-px" role="img" aria-label={t("stats.section.days")}>
        {stats.days.map((day) => (
          <div
            key={day.ts}
            className="min-w-px flex-1 self-end rounded-t-sm bg-signal-wash"
            style={{ height: maxCost === 0 ? 2 : Math.max(2, (day.cost / maxCost) * 100) + "%" }}
            title={`${new Date(day.ts).toLocaleDateString()} — ${t("stats.days.tooltip", {
              tokens: compactNum(day.totalTokens),
              requests: exactNum(day.requests),
            })}`}
          />
        ))}
      </div>
    </Section>
  );
}

function ModelsSection({ rows }: { rows: StatsModelRow[] }) {
  const t = useT();
  const { sort, toggle } = useSort();
  const sorted = sortRows(rows, sort, cell);
  if (rows.length === 0) {
    return (
      <Section title={t("stats.section.models")}>
        <p className="text-[11px] text-ink-faint">{t("stats.empty.noRows")}</p>
      </Section>
    );
  }
  return (
    <Section title={t("stats.section.models")}>
      <table className="w-full">
        <thead>
          <tr>
            <Th label={t("stats.col.model")} column="model" sort={sort} toggle={toggle} />
            <Th label={t("stats.col.provider")} column="provider" sort={sort} toggle={toggle} />
            <Th label={t("stats.col.requests")} column="requests" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.failed")} column="failed" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={`${row.model}\u0000${row.provider}`}>
              <td className="min-w-0 py-0.5 font-mono text-[11px] text-ink-mid" title={row.model}>
                <span className="block truncate">{row.model}</span>
              </td>
              <td className={TD_LEFT}>{row.provider}</td>
              <td className={TD_RIGHT} title={exactNum(row.requests)}>{compactNum(row.requests)}</td>
              <td className={TD_RIGHT} title={exactNum(row.failed)}>{compactNum(row.failed)}</td>
              <td className={TD_RIGHT} title={exactNum(row.totalTokens)}>{compactNum(row.totalTokens)}</td>
              <td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function ProjectsSection({ rows }: { rows: StatsProjectRow[] }) {
  const t = useT();
  const { sort, toggle } = useSort();
  const state = useStore((s) => s.state);
  const labelOf = useMemo(() => {
    const projects = (state?.projects ?? []).map((group) => ({ name: group.project.name, path: group.project.path }));
    return (folder: string): { label: string; title?: string } => {
      if (folder === "") return { label: t("stats.project.unknown") };
      const registered = projects.find(
        (project) => folder === project.path || folder.startsWith(project.path + "/") || folder.startsWith(project.path + "\\"),
      );
      if (registered !== undefined) return { label: registered.name, title: folder };
      const trimmed = folder.replace(/[/\\]+$/, "");
      const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
      return { label: base, title: folder };
    };
  }, [state, t]);
  const sorted = sortRows(rows, sort, (row, column) =>
    column === "folder" ? labelOf(row.folder).label : cell(row, column),
  );
  if (rows.length === 0) {
    return (
      <Section title={t("stats.section.projects")}>
        <p className="text-[11px] text-ink-faint">{t("stats.empty.noRows")}</p>
      </Section>
    );
  }
  return (
    <Section title={t("stats.section.projects")}>
      <table className="w-full">
        <thead>
          <tr>
            <Th label={t("stats.col.project")} column="folder" sort={sort} toggle={toggle} />
            <Th label={t("stats.col.requests")} column="requests" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const { label, title } = labelOf(row.folder);
            return (
              <tr key={row.folder}>
                <td className={TD_LEFT} title={title}>
                  <span className="block truncate">{label}</span>
                </td>
                <td className={TD_RIGHT} title={exactNum(row.requests)}>{compactNum(row.requests)}</td>
                <td className={TD_RIGHT} title={exactNum(row.totalTokens)}>{compactNum(row.totalTokens)}</td>
                <td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function SessionsSection({ rows }: { rows: StatsSessionRow[] }) {
  const t = useT();
  const { sort, toggle } = useSort();
  const state = useStore((s) => s.state);
  const titleOf = useMemo(() => {
    const records = (state?.projects ?? []).flatMap((group) => [
      ...group.sessions.map((session) => ({
        sessionId: session.sessionId,
        lineageDir: session.lineageDir,
        projectCwd: session.projectCwd,
        title: session.title,
      })),
    ]);
    const names = (state?.projects ?? []).map((group) => ({ name: group.project.name, path: group.project.path }));
    return (row: StatsSessionRow): { title: string; project: string } => {
      const record = records.find(
        (rec) =>
          (rec.sessionId !== null && row.sessionFile.includes(rec.sessionId)) ||
          row.sessionFile.includes("/" + rec.lineageDir + "/") ||
          row.sessionFile.includes("\\" + rec.lineageDir + "\\"),
      );
      const fallbackTitle = row.sessionFile.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") ?? row.sessionFile;
      if (record === undefined) return { title: fallbackTitle, project: "" };
      const project = names.find((entry) => entry.path === record.projectCwd)?.name ?? "";
      return { title: record.title, project };
    };
  }, [state]);
  const sorted = sortRows(rows, sort, (row, column) => {
    if (column === "title") return titleOf(row).title;
    if (column === "project") return titleOf(row).project;
    return cell(row, column);
  });
  if (rows.length === 0) {
    return (
      <Section title={t("stats.section.sessions")}>
        <p className="text-[11px] text-ink-faint">{t("stats.empty.noRows")}</p>
      </Section>
    );
  }
  return (
    <Section title={t("stats.section.sessions")}>
      <table className="w-full">
        <thead>
          <tr>
            <Th label={t("stats.col.session")} column="title" sort={sort} toggle={toggle} />
            <Th label={t("stats.col.project")} column="project" sort={sort} toggle={toggle} />
            <Th label={t("stats.col.activity")} column="endedAt" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
            <Th label={t("stats.col.toolCalls")} column="toolCalls" sort={sort} toggle={toggle} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const { title, project } = titleOf(row);
            const models = row.models.join(", ");
            return (
              <tr key={row.sessionFile}>
                <td className={TD_LEFT} title={row.sessionFile}>
                  <span className="block truncate">{title}</span>
                </td>
                <td className={TD_LEFT}>{project}</td>
                <td className={TD_RIGHT} title={new Date(row.endedAt).toLocaleString()}>
                  {relativeTime(new Date(row.endedAt).toISOString())}
                </td>
                <td className={TD_RIGHT} title={exactNum(row.totalTokens)}>{compactNum(row.totalTokens)}</td>
                <td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td>
                <td className={TD_RIGHT} title={models}
                >{compactNum(row.toolCalls)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <Label className="min-w-0 flex-1 truncate">{title}</Label>
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- surface */

export function Stats() {
  const t = useT();
  const view = useStore((s) => s.stats);
  const setStatsRange = useStore((s) => s.setStatsRange);
  const closeStats = useStore((s) => s.closeStats);
  const { load, retry, value } = useKeptStats(view ?? { rangeDays: null });
  if (view === null) return null;

  const rangeLabel = (range: number | null): string =>
    range === null ? t("stats.range.all") : range === 30 ? t("stats.range.month") : t("stats.range.week");

  return (
    <div className="absolute inset-0 overflow-auto bg-void text-ink">
      <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line chrome-void px-3">
        <Label>{t("stats.header.title")}</Label>
        <select
          aria-label={t("stats.header.range")}
          value={String(view.rangeDays)}
          onChange={(event) => {
            const picked = RANGES.find((range) => String(range) === event.target.value);
            if (picked !== undefined) setStatsRange(picked);
          }}
          className="h-6 max-w-[16rem] rounded-md border border-line bg-raised px-1.5 text-[11px] text-ink-mid"
        >
          {RANGES.map((range) => (
            <option key={String(range)} value={String(range)}>
              {rangeLabel(range)}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <IconButton label={t("stats.header.refresh")} onClick={retry}>
          <IconRefresh />
        </IconButton>
        <IconButton label={t("stats.header.close")} onClick={closeStats}>
          <IconClose />
        </IconButton>
      </header>
      {load.status === "error" && (
        <div className="m-3 rounded-md border border-line bg-raised px-3 py-2 text-[11px] text-ink-mid">
          {load.message}
          <span className="ml-2 inline-block">
            <Button variant="ghost" size="xs" onClick={retry}>
              {t("stats.header.refresh")}
            </Button>
          </span>
        </div>
      )}
      {value === null ? (
        load.status === "loading" && (
          <div className="m-3 text-[11px] text-ink-faint">{t("stats.overview.loading")}</div>
        )
      ) : (
        <div className={load.status === "loading" ? "opacity-50" : undefined}>
          {value.dbPath === null ? (
            <div className="m-3 text-[11px] text-ink-faint">{t("stats.empty.none")}</div>
          ) : value.error !== null ? (
            <div className="m-3 rounded-md border border-line bg-raised px-3 py-2 text-[11px] text-ink-mid">
              {t("stats.error.foreign", { error: value.error })}
            </div>
          ) : (
            <>
              <TotalsStrip stats={value} />
              <DaysSection stats={value} />
              <ModelsSection rows={value.models} />
              <ProjectsSection rows={value.projects} />
              <SessionsSection rows={value.sessions} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
