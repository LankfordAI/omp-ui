// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsDataState, StatsOverview, StatsQuery, StatsSyncRun, StatsSyncState } from "@omp-ui/core/types";
import { applyLocale, resolveLocale, t } from "../../lib/i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const read = vi.fn<(query: StatsQuery) => Promise<StatsOverview>>();
const sync = vi.fn<(mode: "if-stale" | "force") => Promise<StatsSyncState>>();
const status = vi.fn<() => Promise<StatsSyncState>>();
Object.assign(window, { ompBackend: { statsOverview: read, statsSync: sync, statsSyncStatus: status, onBrowserPaneFrame: vi.fn() } });
// backend.ts captures window.ompBackend during module evaluation; static imports would precede this fixture.
const { useStore } = await import("../../store");
const { Stats } = await import("./Stats");

const NOW = Date.UTC(2026, 10, 7, 12);
const ALL: StatsQuery = { rangeDays: null, projectKey: null, provider: null, model: null, agentType: null };
const SOURCE = { profile: null, databasePath: "/isolated/stats.db", sessionsRoot: "/isolated/sessions", archiveRoot: "/isolated/archive" };
const PROJECT = { key: "project:/work/app", kind: "project" as const, path: "/work/app", name: "Renamed Project" };
let root: Root | null = null;

function overview(query: StatsQuery = ALL, patch: Partial<StatsOverview> = {}): StatsOverview {
  return {
    query, snapshotAt: NOW, source: SOURCE, databasePresent: true, dataState: "ready", dbPath: SOURCE.databasePath, error: null, rollups: true,
    capabilities: { tools: true, toolOutcomes: true, agentTypes: true },
    facets: { projects: [PROJECT, { key: "chat", kind: "chat" }, { key: "unattributed", kind: "unattributed" }], providers: ["alpha", "beta"], models: [{ provider: "alpha", id: "shared" }, { provider: "beta", id: "shared" }], agentTypes: ["task", "unknown"] },
    coverage: { latestRequestAt: NOW - 1000, indexedFiles: 2, sourceRootMismatch: true, ownedSessionsRoot: "/owned/sessions", archiveOnlyFiles: 1, warnings: [] },
    totals: { requests: 2, failed: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150, premiumRequests: 0, cost: 1.25, unpricedRequests: 0, firstTs: NOW - 2000, lastTs: NOW - 1000, toolCalls: 8 },
    days: [{ ts: Date.UTC(2026, 10, 7), requests: 2, failed: 0, totalTokens: 150, cost: 1.25 }],
    models: [{ model: "shared", provider: "alpha", requests: 2, failed: 0, totalTokens: 150, premiumRequests: 0, cost: 1.25 }],
    projects: [{ identity: PROJECT, requests: 2, totalTokens: 150, cost: 1.25, toolCalls: 8 }],
    sessions: [
      { sessionFile: "/sessions/old.jsonl", title: "Older session", identity: PROJECT, requests: 1, startedAt: NOW - 2000, endedAt: NOW - 1000, totalTokens: 75, cost: 0.5, unpricedRequests: 0, models: ["shared"], toolCalls: 3 },
      { sessionFile: "/sessions/new.jsonl", title: "Newest session", identity: { key: "chat", kind: "chat" }, requests: 1, startedAt: NOW - 1000, endedAt: NOW, totalTokens: 75, cost: 0.75, unpricedRequests: 0, models: ["shared"], toolCalls: 5 },
    ],
    tools: [
      { name: "zeta", calls: 3, completed: 2, errors: 1, noRecordedOutcome: 1, errorRate: 0.5 },
      { name: "alpha", calls: 3, completed: 3, errors: 0, noRecordedOutcome: 0, errorRate: 0 },
      { name: "popular", calls: 9, completed: 0, errors: 0, noRecordedOutcome: 9, errorRate: null },
    ],
    agents: [{ agentType: "task", requests: 2, totalTokens: 150, cost: 1.25, toolCalls: 8 }],
    ...patch,
  };
}
function collection(phase: StatsSyncRun["phase"] | null = null, id = "run-1"): StatsSyncState {
  return { source: SOURCE, sourceError: null, lastSuccessfulSyncAt: phase === "succeeded" ? NOW : null, run: phase === null ? null : { id, phase, startedAt: NOW - 1000, finishedAt: phase === "running" || phase === "stopping" ? null : NOW, exitCode: phase === "succeeded" ? 0 : null, error: phase === "failed" ? "collector failed safely" : null } };
}
async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}
async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Stats />));
  await flush();
}
async function tick(ms = 1000): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flush();
}
function section(name: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  expect(result).not.toBeNull();
  return result!;
}
function rowNames(name: string): string[] {
  return [...section(name).querySelectorAll("tbody tr")].map((row) => row.querySelector("td")!.textContent!);
}
async function choose(label: string, value: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(select).not.toBeNull();
  act(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}
function refresh(): void {
  act(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("stats.header.refresh")}"]`)!.click());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.body.innerHTML = "";
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  applyLocale(resolveLocale("en"));
  read.mockReset().mockImplementation(async (query) => overview(query));
  sync.mockReset().mockResolvedValue(collection("running"));
  status.mockReset().mockResolvedValue(collection("running"));
  useStore.setState({ stats: { ...ALL } });
});
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  vi.useRealTimers();
  applyLocale(resolveLocale("en"));
});

describe("Stats renderer", () => {
  it("reads immediately, starts managed collection, and sorts tools and sessions deterministically", async () => {
    await mount();
    expect(read.mock.calls).toEqual([[ALL]]);
    expect(sync.mock.calls).toEqual([["if-stale"]]);
    expect(document.querySelectorAll("select")).toHaveLength(5);
    expect(rowNames(t("stats.section.tools"))).toEqual(["popular", "alpha", "zeta"]);
    expect(rowNames(t("stats.section.sessions"))).toEqual(["Newest session", "Older session"]);
    expect(rowNames(t("stats.section.projects"))).toEqual([PROJECT.name]);
    expect(section(t("stats.section.projects")).querySelector("tbody td")?.getAttribute("title")).toBe(PROJECT.path);
    expect(section(t("stats.section.days")).querySelector("[role=img] > div")?.getAttribute("title")).toContain("2026-11-07 UTC");
    const calls = [...section(t("stats.section.tools")).querySelectorAll("th button")].find((button) => button.textContent?.startsWith(t("stats.col.toolCalls")))!;
    act(() => (calls as HTMLButtonElement).click());
    expect(rowNames(t("stats.section.tools"))).toEqual(["alpha", "zeta", "popular"]);
    expect(calls.parentElement?.getAttribute("aria-sort")).toBe("ascending");
    expect(section(t("stats.section.tools")).querySelectorAll("tbody tr")[0]?.textContent).toContain("0.0%");
    expect(section(t("stats.coverage.title")).textContent).toContain("/owned/sessions");
  });

  it("applies all filters, pairs model/provider identity, and clears an incompatible model", async () => {
    await mount();
    await choose(t("stats.col.model"), JSON.stringify(["beta", "shared"]));
    expect(useStore.getState().stats).toEqual({ ...ALL, provider: "beta", model: { provider: "beta", id: "shared" } });
    await choose(t("stats.col.provider"), JSON.stringify("alpha"));
    expect(useStore.getState().stats?.model).toBeNull();
    await choose(t("stats.header.range"), "7");
    await choose(t("stats.col.project"), JSON.stringify(PROJECT.key));
    await choose(t("stats.col.agentType"), JSON.stringify("task"));
    expect(read.mock.calls.at(-1)?.[0]).toEqual({ ...ALL, rangeDays: 7, projectKey: PROJECT.key, provider: "alpha", agentType: "task" });
    await choose(t("stats.col.model"), JSON.stringify(["alpha", "shared"]));
    await choose(t("stats.col.provider"), "null");
    expect(useStore.getState().stats?.model).toEqual({ provider: "alpha", id: "shared" });
    await choose(t("stats.col.model"), "null");
    expect(read.mock.calls.at(-1)?.[0].model).toBeNull();
  });

  it("ignores an older overview that arrives after the selected query", async () => {
    const old = Promise.withResolvers<StatsOverview>();
    const latest = Promise.withResolvers<StatsOverview>();
    read.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    await mount();
    await choose(t("stats.header.range"), "7");
    const query = { ...ALL, rangeDays: 7 as const };
    latest.resolve(overview(query, { sessions: [{ ...overview().sessions[0]!, title: "Current selection" }] }));
    await flush();
    old.resolve(overview(ALL, { sessions: [{ ...overview().sessions[0]!, title: "Stale selection" }] }));
    await flush();
    expect(rowNames(t("stats.section.sessions"))).toEqual(["Current selection"]);
    expect(document.body.textContent).not.toContain("Stale selection");
  });

  it("retains and labels the previous selection while loading and after read rejection or database errors", async () => {
    await mount();
    const next = Promise.withResolvers<StatsOverview>();
    read.mockReturnValueOnce(next.promise);
    await choose(t("stats.header.range"), "30");
    expect(document.body.textContent).toContain(t("stats.overview.previousSelection"));
    expect(section(t("stats.section.sessions")).parentElement?.className).toContain("opacity-50");
    next.reject(new Error("read transport unavailable"));
    await flush();
    expect(rowNames(t("stats.section.sessions"))).toEqual(["Newest session", "Older session"]);
    expect(document.body.textContent).toContain("read transport unavailable");
    read.mockResolvedValueOnce(overview({ ...ALL, rangeDays: 7 }, { dataState: "locked", error: "busy fixture" }));
    await choose(t("stats.header.range"), "7");
    expect(document.body.textContent).toContain(t("stats.error.locked"));
    expect(document.body.textContent).toContain(t("stats.overview.previousSelection"));
    expect(rowNames(t("stats.section.sessions"))).toEqual(["Newest session", "Older session"]);
  });

  it("retains snapshot provenance when the host selects another source until Refresh succeeds", async () => {
    sync.mockResolvedValueOnce(collection());
    await mount();
    const target = { ...SOURCE, profile: "work", databasePath: "/other/stats.db", sessionsRoot: "/other/sessions" };
    status.mockResolvedValue({ ...collection(), source: target });
    await tick();
    const coverage = section(t("stats.coverage.title"));
    expect(coverage.textContent).toContain(t("stats.coverage.source", { profile: t("stats.coverage.default"), path: SOURCE.databasePath }));
    expect(coverage.textContent).toContain(t("stats.coverage.target", { profile: "work", path: target.databasePath, root: target.sessionsRoot }));
    expect(section(t("stats.section.sessions")).parentElement?.className).toContain("opacity-50");
    expect(rowNames(t("stats.section.sessions"))).toEqual(["Newest session", "Older session"]);
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    sync.mockResolvedValueOnce({ ...collection("succeeded", "other-run"), source: target });
    read.mockResolvedValueOnce(overview(ALL, { source: target, dbPath: target.databasePath }));
    refresh();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(section(t("stats.section.sessions")).parentElement?.className).not.toContain("opacity-50");
    expect(coverage.textContent).not.toContain(SOURCE.databasePath);
  });

  it("recovers a lost start reply through status and rereads a succeeded run once using the current query", async () => {
    const lost = Promise.withResolvers<StatsSyncState>();
    sync.mockReturnValueOnce(lost.promise);
    status.mockResolvedValue(collection("succeeded"));
    await mount();
    await choose(t("stats.header.range"), "7");
    expect(read).toHaveBeenCalledTimes(2);
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.at(-1)?.[0]).toEqual({ ...ALL, rangeDays: 7 });
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    lost.resolve(collection("running"));
    await flush();
    expect(section(t("stats.coverage.title")).textContent).toContain(t("stats.sync.succeeded"));
    sync.mockResolvedValueOnce(collection("succeeded", "run-2"));
    refresh();
    await flush();
    expect(sync.mock.calls.at(-1)).toEqual(["force"]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not starve a slow status response when another poll is pending", async () => {
    const first = Promise.withResolvers<StatsSyncState>();
    const second = Promise.withResolvers<StatsSyncState>();
    status.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    await tick();
    await tick();
    first.resolve(collection("succeeded"));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    second.resolve(collection("succeeded"));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fences out-of-order status errors and older runs after newer success", async () => {
    const old = Promise.withResolvers<StatsSyncState>();
    status.mockReturnValueOnce(old.promise).mockResolvedValueOnce(collection("succeeded", "newer"));
    await mount();
    await tick();
    await tick();
    old.reject(new Error("obsolete status error"));
    await flush();
    expect(document.body.textContent).not.toContain("obsolete status error");
    expect(read).toHaveBeenCalledTimes(2);
    expect(section(t("stats.coverage.title")).textContent).toContain(t("stats.sync.succeeded"));
  });

  it("keeps sync failures separate from readable data and from read failures", async () => {
    sync.mockRejectedValueOnce(new Error("start transport unavailable"));
    await mount();
    expect(document.body.textContent).toContain("start transport unavailable");
    expect(rowNames(t("stats.section.tools"))).toHaveLength(3);
    status.mockResolvedValueOnce(collection("failed"));
    await tick();
    expect(document.body.textContent).toContain("collector failed safely");
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error("read failed separately"));
    await choose(t("stats.header.range"), "7");
    expect(document.body.textContent).toContain("read failed separately");
    expect(document.body.textContent).toContain("collector failed safely");
    expect(rowNames(t("stats.section.tools"))).toHaveLength(3);
  });

  it("polls only while visible, recovers on reveal, and ignores replies after closing", async () => {
    await mount();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await tick(3000);
    expect(status).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    const pending = Promise.withResolvers<StatsSyncState>();
    status.mockReturnValueOnce(pending.promise);
    await tick();
    act(() => useStore.getState().closeStats());
    pending.resolve(collection("succeeded"));
    await flush();
    await tick(3000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(document.querySelector("header")).toBeNull();
  });

  it("does not restart reads or collection for an equivalent paired-model query", async () => {
    act(() => useStore.getState().setStatsQuery({ ...ALL, provider: "alpha", model: { id: "shared", provider: "alpha" } }));
    await mount();
    act(() => useStore.getState().setStatsQuery({ ...ALL, provider: "alpha", model: { provider: "alpha", id: "shared" } }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLSelectElement>(`select[aria-label="${t("stats.col.model")}"]`)?.value).toBe(JSON.stringify(["alpha", "shared"]));
  });

  it("renders optional capabilities without inventing zero calls or running outcomes", async () => {
    const fixture = overview();
    read.mockResolvedValueOnce(overview(ALL, { capabilities: { tools: true, toolOutcomes: false, agentTypes: false }, agents: [{ agentType: "unknown", requests: 2, cost: 1.25, totalTokens: 150, toolCalls: 8 }], tools: fixture.tools.map((tool) => ({ ...tool, completed: 0, errors: 0, noRecordedOutcome: tool.calls, errorRate: null })) }));
    await mount();
    expect(section(t("stats.section.agents")).textContent).toContain(t("stats.agents.legacy"));
    expect(section(t("stats.section.tools")).textContent).toContain(t("stats.tools.outcomesUnavailable"));
    const cells = section(t("stats.section.tools")).querySelector("tbody tr")!.querySelectorAll("td");
    expect([...cells].map((cell) => cell.textContent)).toEqual(["popular", "9", "—", "—", "9", "—"]);
    read.mockResolvedValueOnce(overview({ ...ALL, rangeDays: 7 }, { capabilities: { tools: false, toolOutcomes: false, agentTypes: false }, totals: { ...fixture.totals, toolCalls: null }, tools: [] }));
    await choose(t("stats.header.range"), "7");
    expect(section(t("stats.section.tools")).querySelector("table")).toBeNull();
    expect(section(t("stats.section.tools")).textContent).toContain(t("stats.tools.unavailable"));
  });

  it.each<StatsDataState>(["missing", "invalid-source", "incompatible", "locked", "corrupt", "error"])("renders %s as a distinct data state", async (dataState) => {
    read.mockResolvedValueOnce(overview(ALL, { dataState, databasePresent: dataState !== "missing", error: dataState === "missing" ? null : "fixture diagnostic" }));
    await mount();
    expect(document.querySelector("table")).toBeNull();
    expect(section(t("stats.coverage.title")).textContent).toContain(SOURCE.databasePath);
    if (dataState === "missing") expect(document.body.textContent).toContain(t("stats.empty.none"));
    else expect(document.querySelector("[role=alert]")?.textContent).toContain("fixture diagnostic");
  });

  it("switches filter controls, diagnostics, and sections to Korean without another read", async () => {
    await mount();
    act(() => applyLocale(resolveLocale("ko")));
    expect(document.querySelector(`select[aria-label="${t("stats.col.agentType")}"]`)).not.toBeNull();
    expect(section(t("stats.section.tools")).textContent).toContain(t("stats.tools.note"));
    expect(document.body.textContent).toContain(t("stats.cost.note"));
    expect(read).toHaveBeenCalledTimes(1);
  });
});
