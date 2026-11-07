import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  StatsAgentRow,
  StatsModelRow,
  StatsOverview,
  StatsProjectIdentity,
  StatsProjectRow,
  StatsQuery,
  StatsSessionRow,
  StatsSyncMode,
  StatsSourceInfo,
  StatsSyncState,
  StatsToolRow,
} from "@omp-ui/core/types";
import { backend, displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { compactNum, exactNum, formatCost, relativeTime } from "../../lib/format";
import { useLoad } from "../../lib/load";
import { startVisibleInterval } from "../../lib/visible-interval";
import { useStore } from "../../store";
import { Button, IconButton, IconClose, IconRefresh, Label } from "../ui";

const RANGES = [null, 30, 7] as const;
const TD_RIGHT = "py-0.5 text-right font-mono text-xs tabular-nums text-ink-mid";
const TD_LEFT = "min-w-0 max-w-[20rem] py-0.5 text-xs text-ink-mid";

function queryKey(query: StatsQuery): string {
  return JSON.stringify([query.rangeDays, query.projectKey, query.provider, query.model?.provider ?? null, query.model?.id ?? null, query.agentType]);
}

function sourceKey(source: StatsSourceInfo | null | undefined): string {
  return JSON.stringify(source ? [source.profile, source.databasePath, source.sessionsRoot, source.archiveRoot] : null);
}

/** useLoad fences superseded reads; only a usable snapshot replaces retained data. */
function useKeptStats(query: StatsQuery) {
  const read = useCallback(() => backend.statsOverview(query), [query]);
  const { load, retry } = useLoad(read);
  const kept = useRef<StatsOverview | null>(null);
  if (load.status === "loaded" && load.value.dataState === "ready") kept.current = load.value;
  const response = load.status === "loaded" ? load.value : null;
  return { load, retry, response, value: kept.current ?? response };
}

/** Observes the host-owned single flight without cancelling it when this view closes. */
function useCollection(onSucceeded: () => void) {
  const [state, setState] = useState<StatsSyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const applied = useRef(0);
  const succeeded = useRef(new Set<string>());
  const start = useRef<(mode: StatsSyncMode) => void>(() => {});

  useEffect(() => {
    let active = true;
    const observe = (read: () => Promise<StatsSyncState>): void => {
      const generation = ++request.current;
      void read().then((next) => {
        if (!active || generation < applied.current) return;
        applied.current = generation;
        setState(next);
        setError(null);
        if (next.run?.phase === "succeeded" && !succeeded.current.has(next.run.id)) {
          succeeded.current.add(next.run.id);
          onSucceeded();
        }
      }, (reason: unknown) => {
        if (active && generation >= applied.current) {
          applied.current = generation;
          setError(displayMessage(reason));
        }
      });
    };
    start.current = (mode) => observe(() => backend.statsSync(mode));
    start.current("if-stale");
    const stop = startVisibleInterval(() => observe(() => backend.statsSyncStatus()), 1000);
    return () => {
      active = false;
      stop();
    };
  }, [onSucceeded]);

  return { state, error, refresh: () => start.current("force") };
}

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-xs uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className="font-mono text-xs tabular-nums text-ink">{value}</span>
    </div>
  );
}

interface Sort { column: string; desc: boolean }
function useSort(initial: Sort | null = null) {
  const [sort, setSort] = useState<Sort | null>(initial);
  const toggle = (column: string): void => {
    setSort((prev) => (prev?.column === column ? { column, desc: !prev.desc } : { column, desc: true }));
  };
  return { sort, toggle };
}
function cell(row: object, column: string): string | number {
  const value = (row as Record<string, unknown>)[column];
  return typeof value === "number" ? value : String(value ?? "");
}
function sortRows<T>(rows: readonly T[], sort: Sort | null, value: (row: T, column: string) => string | number, tie?: (a: T, b: T) => number): T[] {
  if (sort === null) return [...rows];
  return [...rows].sort((a, b) => {
    const x = value(a, sort.column);
    const y = value(b, sort.column);
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return (sort.desc ? -cmp : cmp) || tie?.(a, b) || 0;
  });
}
function Th({ label, column, sort, toggle, align = "left" }: {
  label: string; column: string; sort: Sort | null; toggle: (column: string) => void; align?: "left" | "right";
}) {
  return (
    <th className={align === "right" ? "text-right" : undefined} aria-sort={sort?.column === column ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => toggle(column)} className="text-xs uppercase tracking-[0.08em] text-ink-faint hover:text-ink-mid">
        {label}{sort?.column === column ? (sort.desc ? " ▾" : " ▴") : ""}
      </button>
    </th>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2"><Label className="min-w-0 flex-1 truncate">{title}</Label></div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}
function EmptyRows() {
  const t = useT();
  return <p className="text-xs text-ink-faint">{t("stats.empty.noRows")}</p>;
}
function count(value: number | null): string { return value === null ? "—" : compactNum(value); }
function identityTitle(identity: StatsProjectIdentity): string | undefined {
  return identity.kind === "project" ? identity.path : identity.kind === "unregistered" ? identity.cwd : undefined;
}
function useIdentityLabel() {
  const t = useT();
  return (identity: StatsProjectIdentity): string => {
    switch (identity.kind) {
      case "project": return identity.name;
      case "unregistered": return t("stats.project.unregistered", { cwd: identity.cwd });
      case "chat": return t("stats.project.chat");
      case "unattributed": return t("stats.project.unattributed");
    }
  };
}

function TotalsStrip({ stats }: { stats: StatsOverview }) {
  const t = useT();
  const totals = stats.totals;
  return (
    <section className="border-b border-line-soft px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Stat label={t("stats.col.cost")} value={formatCost(totals.cost)} title={`${totals.cost}`} />
        <Stat label={t("stats.col.tokens")} value={compactNum(totals.totalTokens)} title={exactNum(totals.totalTokens)} />
        <Stat label={t("stats.col.requests")} value={<>{exactNum(totals.requests)}{totals.failed > 0 && <span className="ml-1.5 text-xs text-ink-faint">{t("stats.totals.failed", { n: totals.failed })}</span>}</>} />
        <Stat label={t("stats.col.toolCalls")} value={count(totals.toolCalls)} title={totals.toolCalls === null ? t("stats.tools.unavailable") : exactNum(totals.toolCalls)} />
        <Stat label={t("stats.col.premium")} value={exactNum(totals.premiumRequests)} />
        {totals.unpricedRequests > 0 && <Stat label={t("stats.totals.unpriced")} value={exactNum(totals.unpricedRequests)} />}
      </div>
      <p className="mt-1 text-xs text-ink-faint">{t("stats.cost.note")}</p>
    </section>
  );
}
function DaysSection({ stats }: { stats: StatsOverview }) {
  const t = useT();
  const maxCost = Math.max(0, ...stats.days.map((day) => day.cost));
  return (
    <Section title={t("stats.section.days")}>
      {stats.days.length === 0 ? <EmptyRows /> : <div className="flex h-24 items-end gap-px" role="img" aria-label={t("stats.section.days")}>
        {stats.days.map((day) => {
          const description = `${new Date(day.ts).toISOString().slice(0, 10)} UTC — ${formatCost(day.cost)} — ${t("stats.days.tooltip", { tokens: compactNum(day.totalTokens), requests: exactNum(day.requests) })}`;
          return <div key={day.ts} className="min-w-px flex-1 self-end rounded-t-sm bg-signal-wash" style={{ height: maxCost === 0 ? 2 : Math.max(2, (day.cost / maxCost) * 100) + "%" }} title={description} aria-label={description} />;
        })}
      </div>}
    </Section>
  );
}
function ModelsSection({ rows }: { rows: StatsModelRow[] }) {
  const t = useT();
  const { sort, toggle } = useSort();
  const sorted = sortRows(rows, sort, cell);
  return <Section title={t("stats.section.models")}>
    {rows.length === 0 ? <EmptyRows /> : <table className="w-full"><thead><tr>
      <Th label={t("stats.col.model")} column="model" sort={sort} toggle={toggle} />
      <Th label={t("stats.col.provider")} column="provider" sort={sort} toggle={toggle} />
      <Th label={t("stats.col.requests")} column="requests" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.failed")} column="failed" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
    </tr></thead><tbody>{sorted.map((row) => <tr key={`${row.provider}\u0000${row.model}`}>
      <td className={TD_LEFT} title={row.model}><span className="block truncate font-mono">{row.model}</span></td>
      <td className={TD_LEFT} title={row.provider}><span className="block truncate">{row.provider}</span></td>
      <td className={TD_RIGHT} title={exactNum(row.requests)}>{compactNum(row.requests)}</td>
      <td className={TD_RIGHT} title={exactNum(row.failed)}>{compactNum(row.failed)}</td>
      <td className={TD_RIGHT} title={exactNum(row.totalTokens)}>{compactNum(row.totalTokens)}</td>
      <td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td>
    </tr>)}</tbody></table>}
  </Section>;
}
function AgentsSection({ stats }: { stats: StatsOverview }) {
  const t = useT();
  const { sort, toggle } = useSort();
  const sorted = sortRows<StatsAgentRow>(stats.agents, sort, cell);
  return <Section title={t("stats.section.agents")}>
    {!stats.capabilities.agentTypes && <p className="mb-1 text-xs text-ink-faint">{t("stats.agents.legacy")}</p>}
    {sorted.length === 0 ? <EmptyRows /> : <table className="w-full"><thead><tr>
      <Th label={t("stats.col.agentType")} column="agentType" sort={sort} toggle={toggle} />
      <Th label={t("stats.col.requests")} column="requests" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.toolCalls")} column="toolCalls" sort={sort} toggle={toggle} align="right" />
    </tr></thead><tbody>{sorted.map((row) => <tr key={row.agentType}>
      <td className={TD_LEFT} title={row.agentType}><span className="block truncate">{row.agentType === "unknown" ? t("stats.agent.unknown") : row.agentType}</span></td>
      <td className={TD_RIGHT}>{compactNum(row.requests)}</td><td className={TD_RIGHT}>{compactNum(row.totalTokens)}</td>
      <td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td><td className={TD_RIGHT}>{count(row.toolCalls)}</td>
    </tr>)}</tbody></table>}
  </Section>;
}
function ProjectsSection({ rows }: { rows: StatsProjectRow[] }) {
  const t = useT();
  const labelOf = useIdentityLabel();
  const { sort, toggle } = useSort();
  const sorted = sortRows(rows, sort, (row, column) => column === "project" ? labelOf(row.identity) : cell(row, column));
  return <Section title={t("stats.section.projects")}>
    {rows.length === 0 ? <EmptyRows /> : <table className="w-full"><thead><tr>
      <Th label={t("stats.col.project")} column="project" sort={sort} toggle={toggle} />
      <Th label={t("stats.col.requests")} column="requests" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.toolCalls")} column="toolCalls" sort={sort} toggle={toggle} align="right" />
    </tr></thead><tbody>{sorted.map((row) => <tr key={row.identity.key}>
      <td className={TD_LEFT} title={identityTitle(row.identity) ?? labelOf(row.identity)}><span className="block truncate">{labelOf(row.identity)}</span></td>
      <td className={TD_RIGHT}>{compactNum(row.requests)}</td><td className={TD_RIGHT}>{compactNum(row.totalTokens)}</td>
      <td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td><td className={TD_RIGHT}>{count(row.toolCalls)}</td>
    </tr>)}</tbody></table>}
  </Section>;
}
function ToolsSection({ stats }: { stats: StatsOverview }) {
  const t = useT();
  const { sort, toggle } = useSort({ column: "calls", desc: true });
  const sorted = sortRows<StatsToolRow>(stats.tools, sort, cell, (a, b) => a.name.localeCompare(b.name));
  return <Section title={t("stats.section.tools")}>
    <p className="mb-1 text-xs text-ink-faint">{t("stats.tools.note")}</p>
    {!stats.capabilities.tools ? <p className="text-xs text-ink-faint">{t("stats.tools.unavailable")}</p> : <>
      {!stats.capabilities.toolOutcomes && <p className="mb-1 text-xs text-ink-faint">{t("stats.tools.outcomesUnavailable")}</p>}
      {sorted.length === 0 ? <EmptyRows /> : <table className="w-full"><thead><tr>
        <Th label={t("stats.col.tool")} column="name" sort={sort} toggle={toggle} />
        <Th label={t("stats.col.toolCalls")} column="calls" sort={sort} toggle={toggle} align="right" />
        <Th label={t("stats.col.completed")} column="completed" sort={sort} toggle={toggle} align="right" />
        <Th label={t("stats.col.errors")} column="errors" sort={sort} toggle={toggle} align="right" />
        <Th label={t("stats.col.noOutcome")} column="noRecordedOutcome" sort={sort} toggle={toggle} align="right" />
        <Th label={t("stats.col.errorRate")} column="errorRate" sort={sort} toggle={toggle} align="right" />
      </tr></thead><tbody>{sorted.map((row) => <tr key={row.name}>
        <td className={TD_LEFT} title={row.name}><span className="block truncate font-mono">{row.name}</span></td>
        <td className={TD_RIGHT}>{compactNum(row.calls)}</td>
        <td className={TD_RIGHT}>{stats.capabilities.toolOutcomes ? compactNum(row.completed) : "—"}</td>
        <td className={TD_RIGHT}>{stats.capabilities.toolOutcomes ? compactNum(row.errors) : "—"}</td>
        <td className={TD_RIGHT}>{compactNum(row.noRecordedOutcome)}</td>
        <td className={TD_RIGHT}>{row.errorRate === null ? "—" : `${(row.errorRate * 100).toFixed(1)}%`}</td>
      </tr>)}</tbody></table>}
    </>}
  </Section>;
}
function SessionsSection({ rows }: { rows: StatsSessionRow[] }) {
  const t = useT();
  const labelOf = useIdentityLabel();
  const titleOf = (row: StatsSessionRow): string => row.title ?? row.sessionFile.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") ?? row.sessionFile;
  const { sort, toggle } = useSort({ column: "endedAt", desc: true });
  const sorted = sortRows(rows, sort, (row, column) => column === "title" ? titleOf(row) : column === "project" ? labelOf(row.identity) : cell(row, column), (a, b) => a.sessionFile.localeCompare(b.sessionFile));
  return <Section title={t("stats.section.sessions")}>
    {rows.length === 0 ? <EmptyRows /> : <table className="w-full"><thead><tr>
      <Th label={t("stats.col.session")} column="title" sort={sort} toggle={toggle} />
      <Th label={t("stats.col.project")} column="project" sort={sort} toggle={toggle} />
      <Th label={t("stats.col.activity")} column="endedAt" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.tokens")} column="totalTokens" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.cost")} column="cost" sort={sort} toggle={toggle} align="right" />
      <Th label={t("stats.col.toolCalls")} column="toolCalls" sort={sort} toggle={toggle} align="right" />
    </tr></thead><tbody>{sorted.map((row) => <tr key={row.sessionFile}>
      <td className={TD_LEFT} title={`${titleOf(row)}\n${row.sessionFile}`}><span className="block truncate">{titleOf(row)}</span></td>
      <td className={TD_LEFT} title={identityTitle(row.identity) ?? labelOf(row.identity)}><span className="block truncate">{labelOf(row.identity)}</span></td>
      <td className={TD_RIGHT} title={new Date(row.endedAt).toISOString()}>{relativeTime(new Date(row.endedAt).toISOString())}</td>
      <td className={TD_RIGHT}>{compactNum(row.totalTokens)}</td><td className={TD_RIGHT} title={`${row.cost}`}>{formatCost(row.cost)}</td>
      <td className={TD_RIGHT} title={row.models.join(", ")}>{count(row.toolCalls)}</td>
    </tr>)}</tbody></table>}
  </Section>;
}

function Filter({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return <label className="flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
    <span>{label}</span>
    <select aria-label={label} value={value} title={value === "null" ? label : value} onChange={(event) => onChange(event.target.value)} className="h-6 min-w-0 max-w-[16rem] rounded-md border border-line bg-raised px-1.5 text-xs text-ink-mid">{children}</select>
  </label>;
}
function Filters({ query, stats }: { query: StatsQuery; stats: StatsOverview | null }) {
  const t = useT();
  const labelOf = useIdentityLabel();
  const setQuery = useStore((s) => s.setStatsQuery);
  const facets = stats?.facets;
  const projects = facets?.projects ?? [];
  const providers = [...new Set([...(facets?.providers ?? []), ...(query.provider === null ? [] : [query.provider])])];
  const models = (facets?.models ?? []).filter((model) => query.provider === null || model.provider === query.provider);
  if (query.model !== null && !models.some((model) => model.provider === query.model?.provider && model.id === query.model?.id)) models.push(query.model);
  const agents = [...new Set([...(facets?.agentTypes ?? []), ...(query.agentType === null ? [] : [query.agentType])])];
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft px-3 py-2">
    <Filter label={t("stats.header.range")} value={String(query.rangeDays)} onChange={(value) => {
      const rangeDays = RANGES.find((range) => String(range) === value);
      if (rangeDays !== undefined) setQuery({ ...query, rangeDays });
    }}>{RANGES.map((range) => <option key={String(range)} value={String(range)}>{range === null ? t("stats.range.all") : range === 30 ? t("stats.range.month") : t("stats.range.week")}</option>)}</Filter>
    <Filter label={t("stats.col.project")} value={JSON.stringify(query.projectKey)} onChange={(value) => setQuery({ ...query, projectKey: JSON.parse(value) as string | null })}>
      <option value="null">{t("stats.filter.allProjects")}</option>
      {query.projectKey !== null && !projects.some((project) => project.key === query.projectKey) && <option value={JSON.stringify(query.projectKey)}>{query.projectKey}</option>}
      {projects.map((project) => <option key={project.key} value={JSON.stringify(project.key)} title={identityTitle(project)}>{labelOf(project)}</option>)}
    </Filter>
    <Filter label={t("stats.col.provider")} value={JSON.stringify(query.provider)} onChange={(value) => {
      const provider = JSON.parse(value) as string | null;
      setQuery({ ...query, provider, model: query.model !== null && provider !== null && query.model.provider !== provider ? null : query.model });
    }}><option value="null">{t("stats.filter.allProviders")}</option>{providers.map((provider) => <option key={provider} value={JSON.stringify(provider)}>{provider}</option>)}</Filter>
    <Filter label={t("stats.col.model")} value={query.model === null ? "null" : JSON.stringify([query.model.provider, query.model.id])} onChange={(value) => {
      const pair = JSON.parse(value) as [string, string] | null;
      const model = pair === null ? null : { provider: pair[0], id: pair[1] };
      setQuery({ ...query, model, provider: model?.provider ?? query.provider });
    }}><option value="null">{t("stats.filter.allModels")}</option>{models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.provider} / {model.id}</option>)}</Filter>
    <Filter label={t("stats.col.agentType")} value={JSON.stringify(query.agentType)} onChange={(value) => setQuery({ ...query, agentType: JSON.parse(value) as string | null })}>
      <option value="null">{t("stats.filter.allAgents")}</option>{agents.map((agent) => <option key={agent} value={JSON.stringify(agent)}>{agent === "unknown" ? t("stats.agent.unknown") : agent}</option>)}
    </Filter>
  </div>;
}
function Coverage({ stats, collection, error }: { stats: StatsOverview | null; collection: StatsSyncState | null; error: string | null }) {
  const t = useT();
  const phase = collection?.run?.phase;
  const status = phase === "running" ? t("stats.sync.running") : phase === "stopping" ? t("stats.sync.stopping") : phase === "succeeded" ? t("stats.sync.succeeded") : phase === "failed" ? t("stats.sync.failed") : phase === "cancelled" ? t("stats.sync.cancelled") : t("stats.sync.idle");
  const source = stats?.source ?? collection?.source;
  const differentTarget = collection !== null && sourceKey(collection.source) !== sourceKey(source);
  const warningLabels = {
    "tools-unavailable": "stats.tools.unavailable",
    "tool-outcomes-unavailable": "stats.tools.outcomesUnavailable",
    "indexed-files-unavailable": "stats.coverage.indexedUnknown",
    "archive-coverage-unknown": "stats.coverage.archiveUnknown",
  } as const;
  return <section aria-label={t("stats.coverage.title")} className="border-b border-line-soft px-3 py-2 text-xs text-ink-faint">
    <p role="status" aria-live="polite">{status}</p>
    {source && <p className="truncate" title={source.databasePath}>{t("stats.coverage.source", { profile: source.profile ?? t("stats.coverage.default"), path: source.databasePath })}</p>}
    {differentTarget && collection?.source && <p className="truncate" title={`${collection.source.databasePath}\n${collection.source.sessionsRoot}`}>{t("stats.coverage.target", { profile: collection.source.profile ?? t("stats.coverage.default"), path: collection.source.databasePath, root: collection.source.sessionsRoot })}</p>}
    {stats && <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      <span title={new Date(stats.snapshotAt).toISOString()}>{t("stats.coverage.snapshot", { time: relativeTime(new Date(stats.snapshotAt).toISOString()) })}</span>
      <span>{t("stats.coverage.latest", { time: stats.coverage.latestRequestAt === null ? t("stats.coverage.none") : relativeTime(new Date(stats.coverage.latestRequestAt).toISOString()) })}</span>
      <span>{t("stats.coverage.files", { n: stats.coverage.indexedFiles === null ? t("stats.coverage.unknown") : exactNum(stats.coverage.indexedFiles) })}</span>
      <span>{t("stats.coverage.archiveOnly", { n: stats.coverage.archiveOnlyFiles === null ? t("stats.coverage.unknown") : exactNum(stats.coverage.archiveOnlyFiles) })}</span>
    </div>}
    {collection?.lastSuccessfulSyncAt !== null && collection?.lastSuccessfulSyncAt !== undefined && <p>{t("stats.coverage.lastSync", { time: relativeTime(new Date(collection.lastSuccessfulSyncAt).toISOString()) })}</p>}
    {stats?.coverage.sourceRootMismatch && <p className="mt-1">{t("stats.coverage.mismatch", { root: stats.coverage.ownedSessionsRoot, collectorRoot: stats.source?.sessionsRoot ?? "" })}</p>}
    <p className="mt-1">{t("stats.coverage.archiveNote")}</p>
    {stats?.coverage.warnings.map((warning) => <p key={warning}>{t("stats.coverage.warning", { warning: t(warningLabels[warning]) })}</p>)}
    {(error ?? collection?.sourceError ?? collection?.run?.error) && <p role="alert" className="mt-1 text-ink-mid">{t("stats.error.sync", { error: error ?? collection?.sourceError ?? collection?.run?.error ?? "" })}</p>}
  </section>;
}
function DataState({ stats }: { stats: StatsOverview }) {
  const t = useT();
  const message = stats.dataState === "missing" ? t("stats.empty.none") : stats.dataState === "invalid-source" ? t("stats.error.invalidSource") : stats.dataState === "incompatible" ? t("stats.error.incompatible") : stats.dataState === "locked" ? t("stats.error.locked") : stats.dataState === "corrupt" ? t("stats.error.corrupt") : t("stats.error.read");
  return <div role={stats.dataState === "missing" ? "status" : "alert"} className="m-3 text-xs text-ink-mid">{message}{stats.error !== null && <p className="mt-1">{stats.error}</p>}</div>;
}
function StatsSurface({ view }: { view: StatsQuery }) {
  const t = useT();
  const closeStats = useStore((s) => s.closeStats);
  const query = useMemo<StatsQuery>(() => ({ ...view, model: view.model === null ? null : { ...view.model } }), [view.rangeDays, view.projectKey, view.provider, view.model?.provider, view.model?.id, view.agentType]);
  const { load, retry, response, value } = useKeptStats(query);
  const collection = useCollection(retry);
  const previousSelection = value !== null && queryKey(value.query) !== queryKey(query);
  const previousSource = value?.dataState === "ready" && collection.state !== null && sourceKey(value.source) !== sourceKey(collection.state.source);
  const stale = previousSource || previousSelection || load.status === "loading" || load.status === "error" || (response !== null && response.dataState !== "ready");
  return <div className="absolute inset-0 overflow-auto bg-void text-ink">
    <header className="sticky top-0 z-10 border-b border-line chrome-void">
      <div className="flex h-9 items-center gap-2 px-3">
        <Label>{t("stats.header.title")}</Label><span className="flex-1" />
        <IconButton label={t("stats.header.refresh")} onClick={collection.refresh}><IconRefresh /></IconButton>
        <IconButton label={t("stats.header.close")} onClick={closeStats}><IconClose /></IconButton>
      </div>
      <Filters query={query} stats={value} />
    </header>
    <Coverage stats={value} collection={collection.state} error={collection.error} />
    {load.status === "error" && <div role="alert" className="m-3 text-xs text-ink-mid">{t("stats.error.read")} {load.message}<Button variant="ghost" size="xs" onClick={retry}>{t("stats.header.retryRead")}</Button></div>}
    {response !== null && response.dataState !== "ready" && <DataState stats={response} />}
    {load.status === "loading" && value === null && <p role="status" className="m-3 text-xs text-ink-faint">{t("stats.overview.loading")}</p>}
    {value?.dataState === "ready" && <>
      {stale && <p role="status" className="px-3 pt-2 text-xs text-ink-faint">{previousSource ? t("stats.overview.previousSource") : previousSelection ? t("stats.overview.previousSelection") : t("stats.overview.previousSnapshot")}</p>}
      <div className={stale ? "opacity-50" : undefined} aria-busy={load.status === "loading"}>
        <TotalsStrip stats={value} /><DaysSection stats={value} /><ModelsSection rows={value.models} /><AgentsSection stats={value} />
        <ProjectsSection rows={value.projects} /><ToolsSection stats={value} /><SessionsSection rows={value.sessions} />
      </div>
    </>}
  </div>;
}

/** Main-pane Stats selection, independent of any live tab or renderer registry. */
export function Stats() {
  const view = useStore((s) => s.stats);
  return view === null ? null : <StatsSurface view={view} />;
}
