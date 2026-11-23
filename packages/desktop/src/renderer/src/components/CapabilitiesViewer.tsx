import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  McpServerEntry,
  McpServersResult,
  ScopedCapabilitiesResult,
  SkillCatalogEntry,
} from "@omp-ui/core/types";
import type { McpRuntimeFailure } from "@omp-ui/core/mcp-status";
import type {
  CapabilityReason,
  CapabilitySectionId,
  CapabilitySkill,
  CapabilityTool,
} from "@omp-ui/core/capabilities";
import { backend, backendFor, displayMessage } from "../backend";
import { supportsToolCommands } from "@omp-ui/core/tool-commands";
import { cn } from "../lib/cn";
import { fuzzyBest } from "../lib/fuzzy";
import { useCapabilityRosterSource } from "../lib/use-capability-roster-source";
import { findRecord, sessionCwd, useStore, type CapabilitiesToolFeedbackStatus } from "../store";
import { Button, Chip, ChoiceCapsule, Empty, IconButton, Modal, Panel, Switch } from "./ui";
import { layerBadge } from "./settings/rows";

/**
 * The capabilities viewer (issues #374, #383): one modal, three categories,
 * TWO sources of truth. MCP servers always show resolved config. Skills and
 * Tools show the loaded ROSTER a live native session publishes through the
 * generated bridge when the modal is pinned to a tab — and the scope's
 * CATALOG (config layers + skill roots, `getScopedCapabilities`, ADR-0025)
 * when it is not. Catalogs say what omp CAN load at a scope; rosters say
 * what a session DID load. Neither imitates the other, and an unavailable
 * section says why; it is never rendered as an empty list.
 *
 * Both unpinned entry points — the global viewer and a ProjectSettings embed —
 * read and write the catalog at that scope; the pinned viewer changes nothing.
 *
 * The MCP half inherits the manager's full contract (issue #17): every server
 * omp resolves for one scope — a working tree (`scopeCwd`) or global (`null`,
 * user-level sources only) — with its effective enabled state. All resolution
 * and mutation lives in core; the renderer only ever sees the redacted DTO.
 * The viewer is pinned to a tab (`tabId`) only when opened from a session, and
 * `scopeCwd` is that session's own working tree, not the project root it is
 * registered under: a worktree session's omp resolves project scope in its
 * checkout (issue #325; the checkout's `.omp/` symlinks the project's, so a
 * native write still lands on the project file).
 *
 * Toggle scope follows the modal's scope (#223): a project toggle decides
 * that working tree — an in-place flip, or a suppression override in
 * `.omp/mcp.json` — and writes no user-level definition. Rows that only a
 * global write could enable render a pinned switch instead. A row the
 * user-level allowlist force-enables (`enabledBy: "allowlist"`) stays
 * togglable, because omp honours that list at the user level only: its title
 * reports the reach core computed (`disableReach`) — project-only when the
 * global winner is writable, global when it is tool-owned (#324, #326).
 * Global toggles use omp's own user-level write algorithm.
 *
 * omp has no MCP RPC verbs, but `/mcp reload` rebinds a live session's MCP
 * tools (omp runs `disconnectAll → discoverAndConnect → refreshMCPTools` and
 * answers without an agent turn), so the MCP tab's footer offers that rather
 * than a process restart (#327). The viewer captures scope + tabId at open
 * time, so a focus change mid-edit cannot retarget a toggle at another
 * working tree; a pinned session whose own working tree moved keeps its
 * config rows but detaches every live fact and the session-mutating footer.
 *
 * omp refuses `/mcp reauth` outside its own TUI, so http/sse rows in a live
 * pinned tab offer a handoff instead of a reauth button: the viewer stages
 * the verb for an omp TUI in the tab's console drawer and closes (#243).
 *
 * Pinned (a `tabId`): Skills and Tools are the live roster — never imitated
 * by disk reads; an unavailable section says why. Unpinned (the global viewer
 * and every ProjectSettings embed): they are the scope catalog — files and
 * settings at that scope, mutations routed to that scope's layer only.
 */

type Load =
  | { status: "loading" }
  | { status: "loaded"; result: McpServersResult }
  | { status: "error"; message: string };

/** What one session's MCP runtime status says about one server name. */
type RowStatus = "pending" | "connected" | "failed" | "unknown";

/** Name 3, description 1, source/path/server 1 — one scoring rule, every tab. */
function scoreFields(
  needle: string,
  name: string,
  description: string,
  meta: string,
): number | null {
  if (needle.length === 0) return 0;
  return (
    fuzzyBest(needle, [
      { text: name, weight: 3 },
      { text: description, weight: 1 },
      { text: meta, weight: 1 },
    ])?.score ?? null
  );
}

/** `total`, or `visible/total` once filtering narrows a category. Unknown is an em dash. */
function countLabel(total: number | null, visible: number | null): string {
  if (total === null) return "—";
  if (visible !== null && visible !== total) return `${visible}/${total}`;
  return String(total);
}

function Row({
  entry,
  projectScoped,
  failure,
  status,
  toolsCount,
  pending,
  onToggle,
  onInspectTools,
  onAuthenticate,
}: {
  entry: McpServerEntry;
  failure?: McpRuntimeFailure;
  /** The live session's view of this name; undefined without a session read. */
  status?: RowStatus;
  /** Registered MCP tools owned by this server; null = no tool roster. */
  toolsCount: number | null;
  /** True when the modal is scoped to a working tree (`scopeCwd !== null`). */
  projectScoped: boolean;
  pending: boolean;
  onToggle: (entry: McpServerEntry, next: boolean) => void;
  onInspectTools?: (serverName: string) => void;
  /** Defined only when the modal is pinned to a live tab — the handoff needs
   *  a console drawer to spawn omp's TUI in. */
  onAuthenticate?: (entry: McpServerEntry) => void;
}) {
  const shadowedSource = entry.shadowedBy?.split(":", 1)[0];
  // Exactly the states the project writer rejects: nothing project-local can
  // beat the user denylist or a user-level source's enabled:false.
  const pinnedGlobally =
    projectScoped &&
    entry.state === "disabled" &&
    (entry.disabledBy === "denylist" || entry.scope === "user");
  const inPlaceTitle = `writes enabled:${entry.state === "enabled" ? "false" : "true"} to ${entry.sourcePath}`;
  return (
    <li
      className={cn(
        "flex items-center gap-3 px-4 py-2.5",
        !entry.effective && "opacity-55",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-ink">{entry.name}</span>
          <Chip mono>{entry.transport}</Chip>
          {entry.effective && entry.state === "disabled" && (
            <Chip tone="rose">{`disabled · ${entry.disabledBy ?? ""}`}</Chip>
          )}
          {!entry.effective && shadowedSource !== undefined && (
            <Chip tone="copper" title={entry.shadowedBy}>
              {`shadowed by ${shadowedSource}`}
            </Chip>
          )}
          {/* Liveness is the only colored fact here: rose fails, signal
              connects, everything else stays neutral — including "unknown". */}
          {entry.effective && failure !== undefined && (
            <Chip tone="rose">
              {failure.kind === "auth"
                ? "authentication failed in this session"
                : "connection failed in this session"}
            </Chip>
          )}
          {entry.effective && failure === undefined && status !== undefined && (
            <Chip tone={status === "connected" ? "signal" : "neutral"}>
              {status === "connected"
                ? "connected in this session"
                : status === "pending"
                  ? "connecting in this session"
                  : "status unknown"}
            </Chip>
          )}
        </div>
        <span
          title={entry.endpoint}
          className="mt-0.5 block truncate font-mono text-xs tabular-nums text-ink-mid"
        >
          {entry.endpoint || "—"}
        </span>
        <span
          title={entry.sourcePath}
          className="block truncate text-xs text-ink-faint"
        >
          {entry.source} · {entry.scope}
        </span>
      </div>
      {entry.effective && toolsCount !== null && toolsCount > 0 && onInspectTools !== undefined && (
        <Button size="xs" variant="ghost" onClick={() => onInspectTools(entry.name)}>
          {`${toolsCount} registered tools`}
        </Button>
      )}
      {entry.effective && entry.transport !== "stdio" && onAuthenticate !== undefined && (
        <Button
          size="xs"
          variant="ghost"
          title="hand this session to omp's TUI and run /mcp reauth there — omp refuses OAuth flows over rpc"
          onClick={() => onAuthenticate(entry)}
        >
          authenticate
        </Button>
      )}
      {entry.effective && (
        <Switch
          on={entry.state === "enabled"}
          label={
            entry.state === "enabled"
              ? `disable ${entry.name}`
              : `enable ${entry.name}`
          }
          title={
            projectScoped
              ? pinnedGlobally
                ? "disabled at the user level — enable it globally from Settings → MCP servers"
                : entry.enabledBy === "allowlist"
                  ? entry.disableReach === "global"
                    ? "force-enabled for every project by the user-level allowlist, and its source config is tool-owned — disabling clears that global override, so the server also turns off in other projects"
                    : "force-enabled for every project by the user-level allowlist — disabling enables it in its own config first, so only this project turns it off"
                  : entry.scope === "project" && entry.writable
                    ? inPlaceTitle
                    : "writes a project-only override to .omp/mcp.json"
              : entry.writable
                ? inPlaceTitle
                : "tool-owned file — toggled via omp's user-level override lists"
          }
          disabled={pending || pinnedGlobally}
          onChange={(next) => onToggle(entry, next)}
        />
      )}
    </li>
  );
}

/** A server the live session knows but the resolved config never named — facts only. */
function RuntimeRow({
  name,
  status,
  toolsCount,
  onInspectTools,
}: {
  name: string;
  status: RowStatus;
  toolsCount: number | null;
  onInspectTools?: (serverName: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-ink">{name}</span>
          <Chip mono>mcp</Chip>
          <Chip tone={status === "connected" ? "signal" : status === "failed" ? "rose" : "neutral"}>
            {status === "connected"
              ? "connected in this session"
              : status === "pending"
                ? "connecting in this session"
                : status === "unknown"
                  ? "status unknown"
                  : "connection failed in this session"}
          </Chip>
        </div>
      </div>
      {toolsCount !== null && toolsCount > 0 && onInspectTools !== undefined && (
        <Button size="xs" variant="ghost" onClick={() => onInspectTools(name)}>
          {`${toolsCount} registered tools`}
        </Button>
      )}
    </li>
  );
}

/**
 * Resolved MCP servers for one scope, with per-server toggles. The
 * presentational core of the viewer's MCP tab: load/error/empty states,
 * per-file config errors, the toggle pipeline, and per-row
 * failure/reauth affordances. `scopeCwd` is the working tree whose
 * project-scope config decides — a worktree session's checkout, else a
 * project root — or `null` for global scope. Session-scoped extras (reload,
 * reauth handoff) engage only when a live native `tabId` is pinned; the
 * handoff reports back through `onAuthenticated` so the owning dialog decides
 * what to close.
 *
 * The viewer-only affordances are all optional-prop driven — omitted (the
 * ProjectSettings embedding) this panel is exactly the manager it always
 * was: no filter row, no status column, no tool drill-down, no runtime group.
 */
export function McpServersPanel({
  scopeCwd,
  instanceId = null,
  tabId,
  onAuthenticated,
  query,
  runtimeTools,
  onInspectTools,
  refreshKey,
  onCounts,
}: {
  scopeCwd: string | null;
  /** The remote instance whose config is read and written (issue #416); null for this host. */
  instanceId?: string | null;
  tabId?: string;
  onAuthenticated?: () => void;
  /** The viewer's shared search box; omitted = no filtering. */
  query?: string;
  /** The session's tool roster; null/omitted = no ownership facts, no link. */
  runtimeTools?: CapabilityTool[] | null;
  /** Drills the viewer into its Tools tab pinned to one MCP server. */
  onInspectTools?: (serverName: string) => void;
  /** Bumped by the viewer's Refresh; reruns the config read like a remount. */
  refreshKey?: number;
  /** Reports (visible, total) config rows up so the tab strip can count. */
  onCounts?: (visible: number, total: number | null) => void;
}) {
  const startTuiHandoff = useStore((s) => s.startTuiHandoff);
  const live = useStore((s) =>
    tabId === undefined ? false : findRecord(s.state, tabId)?.live === "live",
  );
  // The handoff needs a console drawer to host omp's TUI, and only native tabs
  // have one. A terminal tab is already an omp TUI — the user runs the verb
  // there directly — so the button would be a dead control.
  const native = useStore((s) =>
    tabId === undefined ? false : findRecord(s.state, tabId)?.mode === "rpc-ui",
  );
  const mcpStatus = useStore((s) =>
    tabId === undefined ? null : (s.rpc[tabId]?.mcpStatus ?? null),
  );

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [toggleError, setToggleError] = useState<string | null>(null);
  /** Name of the server with a toggle in flight; its switch stays disabled. */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [stateFilter, setStateFilter] = useState<"all" | "enabled" | "disabled">("all");
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    backendFor(instanceId).getMcpServers(scopeCwd).then(
      (result) => {
        if (g === gen.current) setLoad({ status: "loaded", result });
      },
      (err: unknown) => {
        if (g === gen.current) setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [scopeCwd, instanceId, reloadKey, refreshKey]);

  const toggle = (entry: McpServerEntry, next: boolean): void => {
    setPendingName(entry.name);
    setToggleError(null);
    backendFor(instanceId)
      .setMcpServerEnabled({
        projectCwd: scopeCwd,
        name: entry.name,
        // Global scope only: the project-override writer (core/mcp-config.ts)
        // resolves the winning definition itself and ignores sourcePath.
        sourcePath: scopeCwd === null && entry.writable ? entry.sourcePath : undefined,
        enabled: next,
      })
      .then(
        (result) => setLoad({ status: "loaded", result }),
        (err: unknown) => setToggleError(displayMessage(err)),
      )
      .finally(() => setPendingName(null));
  };

  // omp refuses `/mcp reauth` outside its TUI, so the row hands the errand to
  // a real omp TUI in the tab's console drawer — undefined (and the button
  // absent) without a live native tab to host it. The panel owns no dialog:
  // the handoff reports back through onAuthenticated.
  const authenticate =
    tabId !== undefined && live && native
      ? (entry: McpServerEntry): void => {
          startTuiHandoff(tabId, `/mcp reauth ${entry.name}`);
          onAuthenticated?.();
        }
      : undefined;

  const result = load.status === "loaded" ? load.result : null;
  const failures = new Map(
    (mcpStatus?.failedServers ?? []).map((failure) => [failure.serverName, failure]),
  );
  const connected = new Set(mcpStatus?.connectedServers ?? []);
  const connecting = new Set(mcpStatus?.pendingServers ?? []);
  // Absent from every set is Unknown — never a silent Connected. Without a
  // session read at all (global scope, ProjectSettings) there is no column.
  const statusFor = (name: string): RowStatus | undefined => {
    if (mcpStatus === null) return undefined;
    if (failures.has(name)) return "failed";
    if (connecting.has(name)) return "pending";
    if (connected.has(name)) return "connected";
    return "unknown";
  };
  const toolsByServer = new Map<string, number>();
  for (const tool of runtimeTools ?? []) {
    if (tool.mcpServerName === null) continue;
    toolsByServer.set(tool.mcpServerName, (toolsByServer.get(tool.mcpServerName) ?? 0) + 1);
  }

  const needle = (query ?? "").trim();
  const configRows = useMemo(() => {
    if (result === null) return null;
    const scored: { entry: McpServerEntry; index: number; score: number }[] = [];
    result.servers.forEach((entry, index) => {
      if (stateFilter !== "all" && entry.state !== stateFilter) return;
      const score = scoreFields(
        needle,
        entry.name,
        "",
        `${entry.source} ${entry.sourcePath} ${entry.endpoint}`,
      );
      if (score !== null) scored.push({ entry, index, score });
    });
    if (needle.length === 0) return scored.map((row) => row.entry);
    return scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((row) => row.entry);
  }, [result, needle, stateFilter]);

  // Present only through the session — live but named by no config row the
  // resolution produced. Facts without affordances: no toggle, no handoff.
  const runtimeOnly = useMemo(() => {
    if (result === null || (mcpStatus === null && runtimeTools === undefined)) return [];
    const named = new Set(result.servers.map((entry) => entry.name));
    const names = new Set<string>([
      ...(mcpStatus?.pendingServers ?? []),
      ...(mcpStatus?.connectedServers ?? []),
      ...(mcpStatus?.failedServers.map((failure) => failure.serverName) ?? []),
      ...(runtimeTools?.flatMap((tool) => (tool.mcpServerName === null ? [] : [tool.mcpServerName])) ?? []),
    ]);
    return [...names].filter((name) => !named.has(name)).sort((a, b) => a.localeCompare(b));
  }, [result, mcpStatus, runtimeTools]);

  const visibleRuntimeOnly = useMemo(
    () => runtimeOnly.filter((name) => scoreFields(needle, name, "", "") !== null),
    [runtimeOnly, needle],
  );

  const totalCount = result === null ? null : result.servers.length + runtimeOnly.length;
  const visibleCount = configRows === null ? 0 : configRows.length + visibleRuntimeOnly.length;
  useEffect(() => {
    onCounts?.(visibleCount, totalCount);
  }, [onCounts, visibleCount, totalCount]);

  const filterable = refreshKey !== undefined;

  return (
    <>
      {load.status === "loading" && (
        <Empty
          title="Resolving MCP servers…"
          hint="Reading omp's config sources."
        />
      )}
      {load.status === "error" && (
        <Empty
          title="Could not resolve MCP servers"
          hint={load.message}
          action={
            <Button size="xs" onClick={() => setReloadKey((k) => k + 1)}>
              retry
            </Button>
          }
        />
      )}
      {result !== null && (
        <div className="py-1.5">
          {result.errors.length > 0 && (
            <Panel tone="rose" className="mx-4 my-2 px-3 py-2">
              <p className="mb-1 text-xs font-medium">
                {result.errors.length === 1
                  ? "One config file could not be read:"
                  : `${result.errors.length} config files could not be read:`}
              </p>
              {result.errors.map((e) => (
                <p key={e.path} className="truncate font-mono text-xs" title={e.path}>
                  {e.path}: {e.message}
                </p>
              ))}
            </Panel>
          )}
          {toggleError !== null && (
            <p className="mx-4 my-2 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
              {toggleError}
            </p>
          )}
          {filterable && (
            <div className="px-4 py-1">
              <ChoiceCapsule
                label="configuration state"
                value={stateFilter}
                onChange={setStateFilter}
                options={[
                  { value: "all", label: "all" },
                  { value: "enabled", label: "enabled" },
                  { value: "disabled", label: "disabled" },
                ]}
              />
            </div>
          )}
          {result.servers.length === 0 && runtimeOnly.length === 0 ? (
            <Empty
              title={
                scopeCwd === null
                  ? "No global MCP servers configured."
                  : "No MCP servers configured for this project."
              }
              hint="omp resolves native .omp/mcp.json files plus translated cursor, claude, gemini, opencode, windsurf, and vscode configs."
            />
          ) : configRows !== null && configRows.length === 0 && visibleRuntimeOnly.length === 0 ? (
            <Empty title="Nothing in this category matches the search." />
          ) : (
            <>
              <ul className="divide-y divide-line-soft">
                {(configRows ?? result.servers).map((entry) => (
                  <Row
                    key={`${entry.source}:${entry.sourcePath}:${entry.name}`}
                    entry={entry}
                    projectScoped={scopeCwd !== null}
                    pending={pendingName === entry.name}
                    failure={failures.get(entry.name)}
                    status={statusFor(entry.name)}
                    toolsCount={runtimeTools === undefined || runtimeTools === null ? null : (toolsByServer.get(entry.name) ?? 0)}
                    onInspectTools={onInspectTools}
                    onToggle={toggle}
                    onAuthenticate={authenticate}
                  />
                ))}
              </ul>
              {visibleRuntimeOnly.length > 0 && (
                <div className="mt-1.5">
                  <p className="px-4 pt-2 pb-1 chrome-label text-ink-faint">
                    Runtime only — not in the resolved config
                  </p>
                  <ul className="divide-y divide-line-soft border-t border-line-soft">
                    {visibleRuntimeOnly.map((name) => (
                      <RuntimeRow
                        key={`runtime:${name}`}
                        name={name}
                        status={statusFor(name) ?? "unknown"}
                        toolsCount={runtimeTools === undefined || runtimeTools === null ? null : (toolsByServer.get(name) ?? 0)}
                        onInspectTools={onInspectTools}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * A catalog mutation without its scope — the panels' scope is fixed at
 * mount, and the union must stay distributive (Omit over a union collapses
 * it to its common keys).
 */
type CatalogMutation =
  | { kind: "tool"; tool: string; enabled: boolean }
  | { kind: "skill-ignore"; name: string; ignored: boolean }
  | { kind: "skill-gate"; key: string; enabled: boolean };
/**
 * One source of catalog truth per mount: `getScopedCapabilities` reads config
 * layers and skill roots — no session, no bridge, no runtime status. Both
 * scope panels share this load shape and its generation guard (the
 * {@link McpServersPanel} skeleton, issue #383 / ADR-0025).
 */
type CatalogLoad =
  | { status: "loading" }
  | { status: "loaded"; result: ScopedCapabilitiesResult }
  | { status: "error"; message: string };

function useCatalogLoad(scopeCwd: string | null, instanceId: string | null, refreshKey: number | undefined): [
  CatalogLoad,
  (next: CatalogLoad) => void,
  () => void,
] {
  const [load, setLoad] = useState<CatalogLoad>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    backendFor(instanceId).getScopedCapabilities(scopeCwd).then(
      (result) => {
        if (g === gen.current) setLoad({ status: "loaded", result });
      },
      (err: unknown) => {
        if (g === gen.current) setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [scopeCwd, instanceId, refreshKey, retryKey]);
  return [load, setLoad, () => setRetryKey((k) => k + 1)];
}

function CatalogError({ load, onRetry }: { load: { status: "error"; message: string }; onRetry: () => void }) {
  return (
    <Empty
      title="Could not read the configuration at this scope"
      hint={load.message}
      action={
        <Button size="xs" onClick={onRetry}>
          retry
        </Button>
      }
    />
  );
}

function CatalogLoading() {
  return <Empty title="reading configuration…" hint="Files and settings at this scope — no session involved." />;
}

/** The scope's skills as config truth: files and settings, not a roster. */
export function SkillsScopePanel({
  scopeCwd,
  instanceId = null,
  query,
  refreshKey,
  onCounts,
}: {
  scopeCwd: string | null;
  /** The remote instance whose config is read and written (issue #416); null for this host. */
  instanceId?: string | null;
  /** The viewer's shared search box; omitted = no filtering. */
  query?: string;
  /** Bumped by the viewer's Refresh; reruns the read like a remount. */
  refreshKey?: number;
  /** Reports (visible, total) rows up so the tab strip can count. */
  onCounts?: (visible: number, total: number | null) => void;
}) {
  const [load, setLoad, retry] = useCatalogLoad(scopeCwd, instanceId, refreshKey);
  const [pendingRow, setPendingRow] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | "listed" | "hidden" | "ignored">("all");

  const skills = load.status === "loaded" ? load.result.skills : null;
  const needle = (query ?? "").trim();
  const rows = useMemo(() => {
    if (skills === null || skills.status !== "available") return null;
    const scored: { skill: SkillCatalogEntry; score: number }[] = [];
    for (const skill of skills.items) {
      if (stateFilter === "listed" && (skill.hidden === true || skill.ignored)) continue;
      if (stateFilter === "hidden" && skill.hidden !== true) continue;
      if (stateFilter === "ignored" && !skill.ignored) continue;
      const score = scoreFields(
        needle,
        skill.name,
        skill.description,
        `${skill.origin} ${skill.filePath} ${skill.scope}`,
      );
      if (score !== null) scored.push({ skill, score });
    }
    if (needle.length === 0) {
      return scored.map((row) => row.skill).sort((a, b) => a.name.localeCompare(b.name));
    }
    return scored
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .map((row) => row.skill);
  }, [skills, needle, stateFilter]);

  const totalCount = skills !== null && skills.status === "available" ? skills.items.length : null;
  const visibleCount = rows === null ? 0 : rows.length;
  useEffect(() => {
    onCounts?.(visibleCount, totalCount);
  }, [onCounts, visibleCount, totalCount]);

  /** One switch click; the refreshed catalogs answer, the row claims nothing. */
  const mutate = (rowKey: string, mutation: CatalogMutation): void => {
    setPendingRow(rowKey);
    setToggleError(null);
    backendFor(instanceId)
      .setScopedCapability({ scopeCwd, ...mutation })
      .then(
        (result) => setLoad({ status: "loaded", result }),
        (err: unknown) => setToggleError(displayMessage(err)),
      )
      .finally(() => setPendingRow(null));
  };

  const lockedBy =
    skills !== null && skills.status === "available" && !skills.masterEnabled
      ? "skills.enabled is off at this scope, so no skill loads from any root; the files still list here and switches are paused."
      : null;
  const filterable = refreshKey !== undefined;

  return (
    <>
      {load.status === "loading" && <CatalogLoading />}
      {load.status === "error" && <CatalogError load={load} onRetry={retry} />}
      {skills !== null && skills.status === "error" && (
        <CatalogError load={skills} onRetry={retry} />
      )}
      {skills !== null && skills.status === "available" && (
        <div className="py-1.5">
          {toggleError !== null && (
            <p className="mx-4 my-2 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
              {toggleError}
            </p>
          )}
          {lockedBy !== null && (
            <Panel tone="copper" className="mx-4 my-2 px-3 py-2">
              <p className="text-xs leading-relaxed text-ink-mid">{lockedBy}</p>
            </Panel>
          )}
          {filterable && (
            <div className="flex items-center gap-2 px-4 pb-1">
              <ChoiceCapsule
                label="skill listing"
                value={stateFilter}
                onChange={setStateFilter}
                options={[
                  { value: "all", label: "all" },
                  { value: "listed", label: "listed" },
                  { value: "hidden", label: "hidden" },
                  { value: "ignored", label: "ignored" },
                ]}
              />
            </div>
          )}
          <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
            Files and settings at this scope — what omp can load. The session tab shows what a live session did load.
          </p>
          {skills.note === "bundles-not-listed" && (
            <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
              omp's bundled skills are embedded in the binary and are not listed here; a live session's roster shows whatever it loaded.
            </p>
          )}
          {skills.truncated && (
            <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
              This scope holds more skill files than the scan lists — the inventory stops at its cap.
            </p>
          )}
          <details className="px-4 py-1">
            <summary className="cursor-pointer text-xs text-ink-faint">
              where we looked
            </summary>
            <ul className="mt-1 space-y-0.5">
              {skills.roots.map((root) => (
                <li key={root.path} className="flex items-center gap-2">
                  <span className="truncate font-mono text-xs text-ink-dim" title={root.path}>
                    {root.path}
                  </span>
                  {!root.exists && <Chip>not present</Chip>}
                  {!root.gateEnabled && <Chip tone="copper">root disabled</Chip>}
                </li>
              ))}
            </ul>
          </details>
          {rows !== null && rows.length === 0 && (
            <Empty
              title={skills.items.length === 0 ? "No entries in this category." : "Nothing in this category matches the search."}
            />
          )}
          {rows !== null && rows.length > 0 && (
            <ul className="divide-y divide-line-soft">
              {rows.map((skill) => (
                <SkillCatalogRow
                  key={`${skill.origin}:${skill.filePath}:${skill.name}`}
                  skill={skill}
                  scopeCwd={scopeCwd}
                  pending={pendingRow === `${skill.origin}:${skill.filePath}`}
                  lockedBy={lockedBy}
                  onMutate={mutate}
                />
              ))}
            </ul>
          )}
          <p className="px-4 pt-2 text-xs text-ink-faint">
            {scopeCwd === null ? "Changes apply to new sessions in every project." : "Changes apply to new sessions in this project."}
          </p>
        </div>
      )}
    </>
  );
}

function SkillCatalogRow({
  skill,
  scopeCwd,
  pending,
  lockedBy,
  onMutate,
}: {
  skill: SkillCatalogEntry;
  scopeCwd: string | null;
  pending: boolean;
  lockedBy: string | null;
  onMutate: (
    rowKey: string,
    mutation: CatalogMutation,
  ) => void;
}) {
  const rowKey = `${skill.origin}:${skill.filePath}`;
  const gateOff = !skill.gateEnabled && skill.gateKey !== null;
  const shadowSource = skill.shadowedBy?.split(":", 1)[0];
  return (
    <li className={cn("px-4 py-2.5", !skill.gateEnabled && "opacity-55")}>
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-ink">{skill.name}</span>
        <Chip mono>{skill.origin}</Chip>
        <Chip mono>{skill.scope}</Chip>
        {skill.hidden === true && <Chip>hidden</Chip>}
        {skill.ignored && <Chip tone="copper">ignored</Chip>}
        {skill.disabledInFile && <Chip>disabled in file</Chip>}
        {gateOff && (
          <Chip title={skill.gateKey ?? undefined}>root disabled</Chip>
        )}
        {shadowSource !== undefined && (
          <Chip tone="copper" title={skill.shadowedBy ?? undefined}>
            {`shadowed by ${shadowSource}`}
          </Chip>
        )}
      </div>
      {skill.description.length > 0 && (
        <p className="mt-0.5 text-xs leading-relaxed text-ink-mid">{skill.description}</p>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-ink-faint">details</summary>
        <p className="mt-0.5 truncate font-mono text-xs text-ink-dim" title={skill.filePath}>
          {skill.filePath}
        </p>
      </details>
      <div className="mt-1 flex justify-end">
        {gateOff ? (
          <Switch
            on={false}
            label={`Enable the root behind ${skill.name}`}
            title={
              lockedBy ??
              `${skill.gateKey ?? ""} is off at the ${scopeCwd === null ? "Global" : "Project"} level; this switch turns it on so the root's skills load again`
            }
            disabled={pending || lockedBy !== null}
            onChange={(next) =>
              onMutate(rowKey, { kind: "skill-gate", key: skill.gateKey ?? "", enabled: next })
            }
          />
        ) : (
          <Switch
            on={skill.ignored}
            label={
              skill.ignored
                ? `Un-ignore ${skill.name}`
                : `Ignore ${skill.name}`
            }
            title={
              lockedBy ??
              (scopeCwd === null
                ? "rewrites skills.ignoredSkills in omp's global settings from its current value"
                : "writes skills.ignoredSkills to this project's .omp/config.yml")
            }
            disabled={pending || lockedBy !== null}
            onChange={(next) => onMutate(rowKey, { kind: "skill-ignore", name: skill.name, ignored: next })}
          />
        )}
      </div>
    </li>
  );
}

/** The scope's tool-enable settings as config truth, one row per omp tool gate. */
export function ToolsScopePanel({
  scopeCwd,
  instanceId = null,
  query,
  refreshKey,
  onCounts,
}: {
  scopeCwd: string | null;
  /** The remote instance whose config is read and written (issue #416); null for this host. */
  instanceId?: string | null;
  query?: string;
  refreshKey?: number;
  onCounts?: (visible: number, total: number | null) => void;
}) {
  const [load, setLoad, retry] = useCatalogLoad(scopeCwd, instanceId, refreshKey);
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const tools = load.status === "loaded" ? load.result.tools : null;
  const needle = (query ?? "").trim();
  const rows = useMemo(() => {
    if (tools === null || tools.status !== "available") return null;
    const scored: { tool: (typeof tools.items)[number]; score: number }[] = [];
    for (const tool of tools.items) {
      const score = scoreFields(needle, tool.tool, "", tool.key);
      if (score !== null) scored.push({ tool, score });
    }
    if (needle.length === 0) {
      return scored.map((row) => row.tool).sort((a, b) => a.tool.localeCompare(b.tool));
    }
    return scored
      .sort((a, b) => b.score - a.score || a.tool.tool.localeCompare(b.tool.tool))
      .map((row) => row.tool);
  }, [tools, needle]);

  const totalCount = tools !== null && tools.status === "available" ? tools.items.length : null;
  useEffect(() => {
    onCounts?.(rows === null ? 0 : rows.length, totalCount);
  }, [onCounts, rows, totalCount]);

  const toggle = (tool: string, next: boolean): void => {
    setPendingTool(tool);
    setToggleError(null);
    backendFor(instanceId)
      .setScopedCapability({ scopeCwd, kind: "tool", tool, enabled: next })
      .then(
        (result) => setLoad({ status: "loaded", result }),
        (err: unknown) => setToggleError(displayMessage(err)),
      )
      .finally(() => setPendingTool(null));
  };

  return (
    <>
      {load.status === "loading" && <CatalogLoading />}
      {load.status === "error" && <CatalogError load={load} onRetry={retry} />}
      {tools !== null && tools.status === "error" && <CatalogError load={tools} onRetry={retry} />}
      {tools !== null && tools.status === "available" && (
        <div className="py-1.5">
          {toggleError !== null && (
            <p className="mx-4 my-2 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
              {toggleError}
            </p>
          )}
          <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
            Tool enable settings at this scope; they apply to sessions started afterwards. Per-session switches live in the session's capabilities view.
          </p>
          {rows !== null && rows.length === 0 && (
            <Empty
              title={tools.items.length === 0 ? "No entries in this category." : "Nothing in this category matches the search."}
            />
          )}
          {rows !== null && rows.length > 0 && (
            <ul className="divide-y divide-line-soft">
              {rows.map((row) => (
                <li key={row.tool} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-ink">{row.tool}</span>
                      <Chip mono>{row.key}</Chip>
                      {row.enabled === null && <Chip>unknown</Chip>}
                      {layerBadge(row.layer)}
                    </div>
                  </div>
                  <Switch
                    on={row.enabled === true}
                    label={
                      row.enabled === true
                        ? `Disable ${row.tool}`
                        : `Enable ${row.tool}`
                    }
                    title={
                      row.enabled === null
                        ? "omp publishes this key without a boolean state — nothing to toggle here"
                        : scopeCwd === null
                          ? "writes the setting to omp's global layer via omp config set"
                          : "writes the setting to this project's .omp/config.yml in place"
                    }
                    disabled={pendingTool === row.tool || row.enabled === null}
                    onChange={(next) => toggle(row.tool, next)}
                  />
                </li>
              ))}
            </ul>
          )}
          <p className="px-4 pt-2 text-xs text-ink-faint">
            {scopeCwd === null ? "Changes apply to new sessions in every project." : "Changes apply to new sessions in this project."}
          </p>
        </div>
      )}
    </>
  );
}

function SkillRow({ skill }: { skill: CapabilitySkill }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-ink">{skill.name}</span>
        <Chip>loaded</Chip>
        {skill.hidden === true && <Chip>hidden</Chip>}
        {skill.source !== null && <Chip mono>{skill.source}</Chip>}
      </div>
      {skill.description.length > 0 && (
        <p className="mt-0.5 text-xs leading-relaxed text-ink-mid">
          {skill.description}
          {skill.descriptionTruncated && (
            <span className="text-ink-faint"> (truncated)</span>
          )}
        </p>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-ink-faint">details</summary>
        <p className="mt-0.5 truncate font-mono text-xs text-ink-dim" title={skill.filePath}>
          {skill.filePath}
        </p>
        {skill.hidden === null && (
          <p className="text-xs text-ink-faint">hidden metadata: unknown</p>
        )}
      </details>
    </li>
  );
}

const TOOL_SOURCE_LABELS: Record<CapabilityTool["source"], string> = {
  builtin: "builtin",
  extension: "extension",
  mcp: "mcp",
  sdk: "sdk",
  unknown: "unknown",
};

/** Unavailable-section reasons, mapped to their explanations. */
const REASON_LABELS: Record<CapabilityReason, string> = {
  "missing-api": "This OMP build exposes no skill inventory for the session.",
  "read-failed": "The session failed to read its skill inventory.",
  "payload-too-large": "The inventory is too large to publish over the bridge — nothing is listed rather than a partial roster.",
};

/**
 * One message per outcome a session-local tool mutation can report (#379).
 * Every branch says what OMP reported about the named tool and where to look
 * for the truth; none of them claims the session is back the way it was.
 */
const TOOL_ERROR_FORMATTERS: Record<CapabilitiesToolFeedbackStatus, (name: string, state: string) => string> = {
  busy: (name) => `OMP was busy, so it refused the change to ${name}.`,
  stale: (name) => `This tab is no longer the session the change to ${name} was issued against — the roster on screen is the current one.`,
  unsupported: (name) => `This session's bridge exposes no tool control, so ${name} cannot be changed from here.`,
  "unknown-tool": (name) => `OMP has no tool named ${name} in this session.`,
  "mode-required": (name) => `OMP needs ${name} enabled for the session's current mode.`,
  expired: (name) => `The change to ${name} expired before OMP reported back.`,
  "apply-failed": (name) => `OMP could not apply the change to ${name}.`,
  "not-applied": (name, state) => `The roster did not confirm ${name} as ${state} after the change.`,
  "missing-session": (name) => `${name}: the session this viewer was pinned to no longer exists.`,
  "not-live": (name) => `${name}: the pinned session is dormant, so there is no live session to change.`,
  terminal: (name) => `${name}: this tab runs an omp TUI, which exposes no tool control over rpc.`,
  "bridge-unavailable": (name) => `${name}: this session's bridge exposes no tool control.`,
  starting: (name) => `${name}: the session is still starting — try again once it is live.`,
  unconfirmed: () => "Could not confirm the change. Refresh to check the current tool state.",
};

function ToolRow({
  tool,
  onToggle,
  pending,
  disabledReason,
  ownReason,
  mountLabel,
}: {
  tool: CapabilityTool;
  /** One deliberate click; the store decides whether it lands (#379). */
  onToggle: (next: boolean) => void;
  /** This row's own mutation is the one in flight. */
  pending: boolean;
  /** Why the switch cannot be clicked — the row's own restriction when
   *  `ownReason`, else the reason the whole tab is locked. */
  disabledReason: string | null;
  /** True when `disabledReason` belongs to THIS row, so it belongs on it. */
  ownReason: boolean;
  /** What this harness calls a mounted tool: "command" (omp 19.1+) or "xd://" (#1270). */
  mountLabel: string;
}) {
  const access: string[] = [];
  if (tool.direct === null) access.push("Direct");
  if (tool.mounted === null) access.push(mountLabel);
  if (tool.evalBridge === null) access.push("Eval");
  // An unobserved membership gets no switch at all: an off-looking control
  // would report "not enabled", which the roster never said.
  const togglable = tool.enabled !== null;
  return (
    // `data-tool` is the row's stable address for the settle handler below:
    // registry names may contain anything, so they travel as data, never as a
    // selector built at runtime.
    <li data-tool={tool.name} className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all text-xs font-medium text-ink">{tool.name}</span>
          <Chip mono>{TOOL_SOURCE_LABELS[tool.source]}</Chip>
          <Chip>
            {tool.enabled === true
              ? "enabled"
              : tool.enabled === false
                ? "not enabled"
                : "unknown"}
          </Chip>
          {/* Access paths: shown when true, absent when false — never a
              "disabled" label for a tool that is reachable as a mounted command
              (omp 19.1+), an xd:// device, or through the eval bridge instead of
              the model. Null is its own chip. */}
          {tool.direct === true && <Chip>Direct</Chip>}
          {tool.direct === null && (
            <Chip title={`${"Direct"}: unknown`}>
              {`${"Direct"}: unknown`}
            </Chip>
          )}
          {tool.mounted === true && <Chip>{mountLabel}</Chip>}
          {tool.mounted === null && (
            <Chip title={`${mountLabel}: unknown`}>
              {`${mountLabel}: unknown`}
            </Chip>
          )}
          {tool.evalBridge === true && <Chip>Eval</Chip>}
          {tool.evalBridge === null && (
            <Chip title={`${"Eval"}: unknown`}>
              {`${"Eval"}: unknown`}
            </Chip>
          )}
          {tool.mcpServerName !== null && <Chip mono>{tool.mcpServerName}</Chip>}
        </div>
        {tool.description.length > 0 && (
          <p className="mt-0.5 text-xs leading-relaxed text-ink-mid">
            {tool.description}
            {tool.descriptionTruncated && (
              <span className="text-ink-faint"> (truncated)</span>
            )}
          </p>
        )}
        {ownReason && disabledReason !== null && (
          <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
            {disabledReason}
          </p>
        )}
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-ink-faint">details</summary>
          {tool.sourcePath !== null && (
            <p className="mt-0.5 truncate font-mono text-xs text-ink-dim" title={tool.sourcePath}>
              {tool.sourcePath}
            </p>
          )}
          {tool.mcpServerName !== null && (
            <p className="font-mono text-xs text-ink-dim">
              {tool.mcpServerName}
              {tool.mcpToolName !== null ? ` · ${tool.mcpToolName}` : ""}
            </p>
          )}
          {access.length > 0 && (
            <p className="text-xs text-ink-faint">
              {`access facts not reported: ${access.join(", ")}`}
            </p>
          )}
        </details>
      </div>
      <div className="flex w-7 shrink-0 justify-end pt-0.5">
        {togglable && (
          <Switch
            on={tool.enabled === true}
            label={
              pending
                ? "Applying…"
                : tool.enabled === true
                  ? `Disable ${tool.name}`
                  : `Enable ${tool.name}`
            }
            title={disabledReason ?? undefined}
            disabled={pending || disabledReason !== null}
            onChange={onToggle}
          />
        )}
      </div>
    </li>
  );
}

export function CapabilitiesViewer({
  scopeCwd,
  tabId,
  section = "mcp",
  instanceId = null,
}: {
  scopeCwd: string | null;
  tabId?: string;
  section?: CapabilitySectionId;
  /** The remote instance the scope lives on (issue #416); null for this host. */
  instanceId?: string | null;
}) {
  const closeCapabilitiesViewer = useStore((s) => s.closeCapabilitiesViewer);
  const refreshCapabilities = useStore((s) => s.refreshCapabilities);
  const setSessionToolEnabled = useStore((s) => s.setSessionToolEnabled);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const state = useStore((s) => s.state);
  const {
    record,
    busy,
    loadStatus,
    snapshot,
    toolPending,
    toolFeedback,
    planModeOn,
    runtimeBusy,
  } = useCapabilityRosterSource(tabId);
  const live = record?.live === "live";
  const native = record?.mode === "rpc-ui";
  const worktree = record?.worktree ?? null;

  const [active, setActive] = useState<CapabilitySectionId>(section);
  const [query, setQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [reloading, setReloading] = useState(false);
  // The drill-down pins exact server ownership in the Tools tab; the filters
  // it clears live here too, lifted from the tab body.
  const [toolStatus, setToolStatus] = useState<"all" | "enabled" | "disabled" | "unknown">("all");
  const [toolOrigin, setToolOrigin] = useState<"all" | CapabilityTool["source"]>("all");
  const [toolServer, setToolServer] = useState<string | null>(null);
  const [skillView, setSkillView] = useState<"all" | "listed" | "hidden" | "unknown">("all");
  const [sectionCounts, setSectionCounts] = useState<
    Record<CapabilitySectionId, { visible: number; total: number | null } | null>
  >({ mcp: null, skills: null, tools: null });
  const tabRefs = useRef<Record<CapabilitySectionId, HTMLButtonElement | null>>({
    mcp: null,
    skills: null,
    tools: null,
  });

  // "idle" means nobody has asked this tab for a roster yet: pull once on
  // open. Everything after is the bridge's own ~2s publish or Refresh.
  useEffect(() => {
    if (tabId !== undefined && loadStatus === "idle") void refreshCapabilities(tabId).catch(() => {});
  }, [tabId, loadStatus, refreshCapabilities]);

  // The viewer is pinned to the scope it captured, never retargeted by focus.
  // A session that moved to a different working tree since keeps its config
  // rows (resolved from the captured scope) but loses every live fact — the
  // roster and runtime status describe a tree these rows no longer drive.
  const effectiveCwd = tabId === undefined ? undefined : sessionCwd(record);
  const drifted =
    tabId !== undefined &&
    record !== undefined &&
    effectiveCwd !== undefined &&
    effectiveCwd !== scopeCwd;
  const missingSession =
    tabId !== undefined && record === undefined && state !== null && !drifted;
  const roster =
    !drifted &&
    !missingSession &&
    snapshot !== null &&
    (loadStatus === "available" || loadStatus === "error")
      ? snapshot
      : null;
  const sessionTools =
    roster !== null && roster.tools.status === "available"
      ? roster.tools.items
      : null;
  // omp 19.1 mounts rarely-used tools as bash commands; an older harness
  // mounts them as xd:// devices (#1270). The chip names what the session runs.
  const mountLabel =
    roster !== null && supportsToolCommands(roster.ompVersion) ? "command" : "xd://";

  const reload = (): void => {
    if (tabId === undefined) return;
    setReloading(true);
    const done = (): void => {
      setReloading(false);
      closeCapabilitiesViewer();
    };
    if (native) void runSlashCommand(tabId, "/mcp reload").then(done, done);
    else {
      backend.ptyWrite(tabId, "/mcp reload\r");
      done();
    }
  };

  const refresh = (): void => {
    setRefreshKey((key) => key + 1);
    if (tabId !== undefined && !drifted) {
      void refreshCapabilities(tabId).catch(() => {});
    }
  };

  const reportCounts = useCallback(
    (sectionId: CapabilitySectionId, visible: number, total: number | null) => {
      setSectionCounts((current) => {
        const retained = current[sectionId];
        return retained?.visible === visible && retained.total === total
          ? current
          : { ...current, [sectionId]: { visible, total } };
      });
    },
    [],
  );
  const reportMcpCounts = useCallback(
    (visible: number, total: number | null) => reportCounts("mcp", visible, total),
    [reportCounts],
  );
  const reportSkillCatalogCounts = useCallback(
    (visible: number, total: number | null) => reportCounts("skills", visible, total),
    [reportCounts],
  );
  const reportToolCatalogCounts = useCallback(
    (visible: number, total: number | null) => reportCounts("tools", visible, total),
    [reportCounts],
  );

  const openToolsFor = useCallback((serverName: string) => {
    setQuery("");
    setToolStatus("all");
    setToolOrigin("all");
    setToolServer(serverName);
    setActive("tools");
  }, []);

  const needle = query.trim();
  const skillRows = useMemo(() => {
    if (roster === null || roster.skills.status !== "available") return null;
    const scored: { skill: CapabilitySkill; score: number }[] = [];
    for (const skill of roster.skills.items) {
      if (skillView === "listed" && skill.hidden !== false) continue;
      if (skillView === "hidden" && skill.hidden !== true) continue;
      if (skillView === "unknown" && skill.hidden !== null) continue;
      const score = scoreFields(
        needle,
        skill.name,
        skill.description,
        `${skill.source ?? ""} ${skill.filePath} ${skill.scope ?? ""}`,
      );
      if (score !== null) scored.push({ skill, score });
    }
    if (needle.length === 0) {
      return scored.map((row) => row.skill).sort((a, b) => a.name.localeCompare(b.name));
    }
    return scored
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .map((row) => row.skill);
  }, [roster, needle, skillView]);

  const toolRows = useMemo(() => {
    if (roster === null || roster.tools.status !== "available") return null;
    const scored: { tool: CapabilityTool; score: number }[] = [];
    for (const tool of roster.tools.items) {
      if (toolStatus === "enabled" && tool.enabled !== true) continue;
      if (toolStatus === "disabled" && tool.enabled !== false) continue;
      if (toolStatus === "unknown" && tool.enabled !== null) continue;
      if (toolOrigin !== "all" && tool.source !== toolOrigin) continue;
      if (toolServer !== null && tool.mcpServerName !== toolServer) continue;
      const score = scoreFields(needle, tool.name, tool.description, `${tool.source} ${tool.sourcePath ?? ""} ${tool.mcpServerName ?? ""}`);
      if (score !== null) scored.push({ tool, score });
    }
    if (needle.length === 0) {
      return scored.map((row) => row.tool).sort((a, b) => a.name.localeCompare(b.name));
    }
    return scored
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .map((row) => row.tool);
  }, [roster, needle, toolStatus, toolOrigin, toolServer]);

  // --- session-local tool control (issue #379) -----------------------------
  // Every persistent restriction on this tab's switches, in the order a reader
  // should hear them. Each is also the switch's own tooltip, so a locked
  // control never has to be discovered by clicking it. A missing, dormant, or
  // terminal session never renders rows at all — `liveUnavailable` says why —
  // so nothing here has to repeat it.
  const toolLocks: string[] = [];
  if (roster !== null) {
    if (roster.toolControl !== "available")
      toolLocks.push("This bridge publishes no tool control, so the roster cannot be changed here.");
    if (loadStatus === "error") toolLocks.push("The last refresh failed, so this roster may be out of date — changes are paused until a fresh one arrives.");
    if (runtimeBusy) toolLocks.push("This session is mid-turn or has queued messages — tool changes wait until it settles.");
  }
  const tabToolLock = toolLocks.length > 0 ? toolLocks.join(" ") : null;

  /** One deliberate click. The store owns the guard, the pending record, and
   *  the roster that confirms the change; this forwards the intent and claims
   *  nothing on its own. */
  const toggleTool = useCallback(
    (name: string, next: boolean): void => {
      if (tabId === undefined || drifted) return;
      void setSessionToolEnabled(tabId, name, next);
    },
    [tabId, drifted, setSessionToolEnabled],
  );

  const statusFilterRef = useRef<HTMLSpanElement | null>(null);
  const settledTool = useRef<string | null>(null);

  // A settled change recomputes the rows and the counts from the new roster.
  // A disabled control drops focus to the document in every browser, so a
  // dropped focus goes back to the row's switch — and when the confirmed
  // membership no longer matches the filter the reader set, that row is gone
  // and focus lands on the filter that hid it rather than vanishing. The live
  // region above tells the result either way; nothing here clears a search or
  // moves a filter on its own.
  useEffect(() => {
    if (toolPending !== null) {
      settledTool.current = toolPending.name;
      return;
    }
    const settled = settledTool.current;
    settledTool.current = null;
    if (settled === null || active !== "tools" || toolFeedback !== null) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    if ((toolRows ?? []).some((row) => row.name === settled)) {
      const row = [...document.body.querySelectorAll<HTMLElement>("[data-tool]")].find(
        (node) => node.dataset.tool === settled,
      );
      row?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus();
      return;
    }
    const group = statusFilterRef.current;
    const target =
      group?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
      group?.querySelector<HTMLButtonElement>("button");
    target?.focus();
  }, [toolPending, toolFeedback, toolRows, active]);

  /**
   * The Tools tab's live region (issue #379): keyed to the tool the reader
   * attempted, and rendered at tab level so filtering can never hide an
   * answer about a row the filter now excludes.
   */
  const toolLiveRegion = (): React.ReactNode => {
    if (toolFeedback !== null) {
      const wanted = toolFeedback.enabled
        ? "enabled"
        : "not enabled";
      return (
        <>
          <p className="text-xs leading-relaxed text-rose">
            {TOOL_ERROR_FORMATTERS[toolFeedback.status](toolFeedback.name, wanted)}
          </p>
          {toolFeedback.status !== "unsupported" &&
            toolFeedback.status !== "mode-required" &&
            toolFeedback.status !== "unknown-tool" && (
              <p className="mt-0.5 text-xs text-ink-faint">
                Click the switch again to retry.
              </p>
            )}
        </>
      );
    }
    if (toolPending !== null) {
      return (
        <p className="text-xs text-ink-mid">
          {`Applying ${toolPending.name} to this session…`}
        </p>
      );
    }
    const record = roster?.toolMutation ?? null;
    if (record !== null && record.status === "applied") {
      return (
        <p className="text-xs text-ink-mid">
          {`${record.name} is now ${record.enabled
              ? "enabled"
              : "not enabled"} in this session.`}
        </p>
      );
    }
    return null;
  };

  const TABS: { id: CapabilitySectionId; label: string }[] = [
    { id: "mcp", label: "MCP servers" },
    { id: "skills", label: "Skills" },
    { id: "tools", label: "Tools" },
  ];
  const onTabListKeyDown = (event: React.KeyboardEvent): void => {
    const index = TABS.findIndex((tab) => tab.id === active);
    const target =
      event.key === "ArrowRight" ? (index + 1) % TABS.length
      : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
      : event.key === "Home" ? 0
      : event.key === "End" ? TABS.length - 1
      : null;
    if (target === null) return;
    event.preventDefault();
    const next = TABS[target]!;
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  };

  /** What the live sections show when there is no roster to show. */
  const liveUnavailable = (): React.ReactNode => {
    if (drifted) return <Empty title="The session moved to a different working tree — its live rosters are detached from this viewer." />;
    if (missingSession) return <Empty title="The session this viewer was pinned to no longer exists." />;
    switch (loadStatus) {
      case "idle":
      case "loading":
        return <Empty title="reading session…" hint="The capabilities bridge publishes the roster shortly after boot." />;
      case "starting":
        return <Empty title="The session is still starting — the roster arrives once it is live." />;
      case "bridge-unavailable":
        return <Empty title="Skills and Tools require a live native session." hint="An older OMP build or a failed bridge generation publishes no roster." />;
      case "terminal":
        return <Empty title="This tab runs an omp TUI — terminal sessions publish no capability roster over rpc." />;
      case "not-live":
        return <Empty title="The pinned session is dormant — no live roster to read." />;
      case "missing-session":
        return <Empty title="The session this viewer was pinned to no longer exists." />;
      case "error":
        return (
          <Empty
            title="The last capabilities refresh failed."
            action={
              <Button size="xs" onClick={refresh}>
                retry
              </Button>
            }
          />
        );
      default:
        // "available" with no snapshot yet is the same read-in-flight state.
        return <Empty title="reading session…" hint="The capabilities bridge publishes the roster shortly after boot." />;
    }
  };

  const skillTotal = roster !== null && roster.skills.status === "available" ? roster.skills.items.length : null;
  const toolTotal = roster !== null && roster.tools.status === "available" ? roster.tools.items.length : null;
  const sectionCount = (sectionId: CapabilitySectionId): string => {
    if (sectionId === "mcp" || tabId === undefined) {
      const counts = sectionCounts[sectionId];
      return countLabel(counts?.total ?? null, counts?.visible ?? null);
    }
    return sectionId === "skills"
      ? countLabel(skillTotal, skillRows?.length ?? null)
      : countLabel(toolTotal, toolRows?.length ?? null);
  };


  return (
    <Modal onClose={closeCapabilitiesViewer} width="w-[42rem]" labelledBy="capabilities-viewer-title">
      <header className="border-b border-line px-4 py-3.5">
        <p className="mb-1 chrome-label text-ink-faint">
          {scopeCwd === null ? "Global" : "Project"}
        </p>
        <h2 id="capabilities-viewer-title" className="text-base font-semibold text-ink">
          Capabilities
        </h2>
        {record !== undefined && record.title.length > 0 && (
          <p className="mt-0.5 truncate text-xs text-ink-mid">{`Session: ${record.title}`}</p>
        )}
        <p title={scopeCwd ?? undefined} className="mt-1 truncate font-mono text-xs text-ink-dim">
          {scopeCwd ?? "Global MCP configuration"}
        </p>
        {/* Names the directory the rows were resolved from, so a checkout's
            own tracked provider files (.cursor/mcp.json, opencode.json, …)
            differing from the project's is explainable, not mysterious. */}
        {worktree !== null && (
          <p className="mt-0.5 truncate font-mono text-xs text-ink-faint" title={record?.projectCwd}>
            ⎇ {worktree.branch}{` — resolved in this session's checkout, written through it to ${record?.projectCwd ?? ""}`}
          </p>
        )}
        <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
          {tabId === undefined ? "Skills and Tools show the files and settings at this scope — what omp can load, not what any session loaded. The session's capabilities view shows a live roster instead." : "Skills and Tools describe the loaded roster of the selected live native session — not a machine-wide catalog. Skill files that are disabled or filtered from loading are not listed; loaded skills marked hidden are."}
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2">
        <div role="tablist" aria-label="Capabilities" onKeyDown={onTabListKeyDown} className="flex gap-1">
          {TABS.map((tab) => {
            const selected = tab.id === active;
            const count = sectionCount(tab.id);
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                id={`capabilities-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`capabilities-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  selected ? "bg-hover text-ink" : "text-ink-mid hover:text-ink",
                )}
              >
                {tab.label}
                <span className="font-mono text-xs tabular-nums text-ink-faint">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            data-modal-initial-focus
            type="search"
            aria-label="Search this category"
            placeholder="Search this category"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-6 w-44 rounded-md border border-line bg-raised px-2 text-xs text-ink placeholder:text-ink-faint"
          />
          <Button size="xs" variant="ghost" title="re-read config and ask the session for a fresh snapshot — live snapshots refresh ~every 2 seconds by themselves" onClick={refresh}>
            refresh
          </Button>
        </div>
      </div>

      {drifted && (
        <Panel tone="copper" className="mx-4 my-2 px-3 py-2">
          <p className="text-xs leading-relaxed text-ink-mid">{`The pinned session has moved to a different working tree — its live facts and session commands are detached from these ${scopeCwd ?? "Global MCP configuration"} rows. Close and reopen the viewer to follow it.`}</p>
        </Panel>
      )}
      {loadStatus === "error" && roster !== null && (
        <Panel tone="copper" className="mx-4 my-2 px-3 py-2">
          <p className="flex items-center gap-2 text-xs text-ink-mid">
            last known snapshot — the latest refresh failed
            <Button size="xs" onClick={refresh}>
              retry
            </Button>
          </p>
        </Panel>
      )}

      <div
        role="tabpanel"
        id={`capabilities-panel-${active}`}
        aria-labelledby={`capabilities-tab-${active}`}
        tabIndex={-1}
        className="max-h-[24rem] overflow-y-auto"
      >
        {active === "mcp" && (
          <McpServersPanel
            scopeCwd={scopeCwd}
            instanceId={instanceId}
            tabId={drifted ? undefined : tabId}
            onAuthenticated={closeCapabilitiesViewer}
            query={query}
            runtimeTools={sessionTools}
            onInspectTools={openToolsFor}
            refreshKey={refreshKey}
            onCounts={reportMcpCounts}
          />
        )}
        {active === "skills" && tabId === undefined && (
          <SkillsScopePanel
            scopeCwd={scopeCwd}
            instanceId={instanceId}
            query={query}
            refreshKey={refreshKey}
            onCounts={reportSkillCatalogCounts}
          />
        )}
        {active === "skills" && tabId !== undefined && (
          <>
            {roster === null && liveUnavailable()}
            {roster !== null && roster.skills.status === "unavailable" && (
              <Empty title={REASON_LABELS[roster.skills.reason]} hint="Skills describe the live session only; the config on disk is not listed here." />
            )}
            {roster !== null && roster.skills.status === "available" && (
              <div className="py-1.5">
                <div className="flex items-center gap-2 px-4 pb-1">
                  <ChoiceCapsule
                    label="skill listing"
                    value={skillView}
                    onChange={setSkillView}
                    options={[
                      { value: "all", label: "all" },
                      { value: "listed", label: "listed" },
                      { value: "hidden", label: "hidden" },
                      { value: "unknown", label: "unknown" },
                    ]}
                  />
                </div>
                <p className="px-4 py-1 text-xs text-ink-faint">
                  {`skill slash commands ${roster.skillCommandsEnabled === true
                        ? "enabled"
                        : roster.skillCommandsEnabled === false
                          ? "disabled"
                          : "unknown"} in session`}
                </p>
                <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">Loaded means the session roster includes it — not that any turn invoked it.</p>
                {skillRows !== null && skillRows.length === 0 && (
                  <Empty
                    title={roster.skills.items.length === 0 ? "No entries in this category." : "Nothing in this category matches the search."}
                  />
                )}
                {skillRows !== null && skillRows.length > 0 && (
                  <ul className="divide-y divide-line-soft">
                    {skillRows.map((skill) => (
                      <SkillRow key={`${skill.source ?? ""}:${skill.filePath}:${skill.name}`} skill={skill} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        {active === "tools" && tabId === undefined && (
          <ToolsScopePanel
            scopeCwd={scopeCwd}
            instanceId={instanceId}
            query={query}
            refreshKey={refreshKey}
            onCounts={reportToolCatalogCounts}
          />
        )}
        {active === "tools" && tabId !== undefined && (
          <>
            {/* Session-local tool control lives here: one live region for the
                attempted tool plus the persistent restrictions, both above the
                rows so a filter can never hide an answer (#379). */}
            <div role="status" aria-live="polite" className="px-4 pt-1.5">
              {toolLiveRegion()}
            </div>
            {toolLocks.length > 0 && (
              <Panel tone="copper" className="mx-4 my-2 px-3 py-2">
                {toolLocks.map((reason) => (
                  <p key={reason} className="text-xs leading-relaxed text-ink-mid">
                    {reason}
                  </p>
                ))}
              </Panel>
            )}
            {roster === null && liveUnavailable()}
            {roster !== null && roster.tools.status === "unavailable" && (
              <Empty title={REASON_LABELS[roster.tools.reason]} hint="Tools describe the live session only; unloaded servers list nothing here." />
            )}
            {roster !== null && roster.tools.status === "available" && (
              <div className="py-1.5">
                <div className="flex flex-wrap items-center gap-2 px-4 pb-1.5">
                  <span ref={statusFilterRef}>
                    <ChoiceCapsule
                      label="enabled state"
                      value={toolStatus}
                      onChange={setToolStatus}
                      options={[
                        { value: "all", label: "all" },
                        { value: "enabled", label: "enabled" },
                        { value: "disabled", label: "not enabled" },
                        { value: "unknown", label: "unknown" },
                      ]}
                    />
                  </span>
                  <select
                    aria-label="origin"
                    value={toolOrigin}
                    onChange={(e) => setToolOrigin(e.target.value as "all" | CapabilityTool["source"])}
                    className="h-6 rounded-md border border-line bg-raised px-1.5 text-xs text-ink-mid"
                  >
                    <option value="all">all origins</option>
                    <option value="builtin">builtin</option>
                    <option value="extension">extension</option>
                    <option value="mcp">mcp</option>
                    <option value="sdk">sdk</option>
                    <option value="unknown">unknown</option>
                  </select>
                  {toolServer !== null && (
                    <span className="flex items-center gap-1">
                      <Chip mono title={toolServer}>{toolServer}</Chip>
                      <IconButton
                        label={`clear ${toolServer} filter`}
                        onClick={() => setToolServer(null)}
                      >
                        ×
                      </IconButton>
                    </span>
                  )}
                </div>
                <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
                  Changes apply to this live session only. Restarting or switching sessions resets tool selection. OMP settings changes and MCP reload may change it again.
                </p>
                <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
                  Every row here is registered in this session; enabled means the model may call it directly. A tool absent from this list was never registered — that is OMP's registry, not a setting here.
                </p>
                {(sessionTools ?? []).some(
                  (tool) => tool.source === "mcp" || tool.mcpServerName !== null,
                ) && (
                  <p className="px-4 py-1 text-xs leading-relaxed text-ink-faint">
                    Reloading MCP can re-enable its tools. Use MCP servers to change server configuration.
                  </p>
                )}
                {toolRows !== null && toolRows.length === 0 && (
                  <Empty
                    title={roster.tools.items.length === 0 ? "No entries in this category." : "Nothing in this category matches the search."}
                  />
                )}
                {toolRows !== null && toolRows.length > 0 && (
                  <ul className="divide-y divide-line-soft">
                    {toolRows.map((tool) => {
                      // Plan mode owns `write`: omp hands it to the session
                      // while planning, so this row's lock is its own story.
                      const ownReason =
                        planModeOn && tool.name === "write"
                          ? "Required to write plan artifacts while Plan mode is on."
                          : null;
                      const disabledReason =
                        ownReason ??
                        tabToolLock ??
                        (toolPending !== null && toolPending.name !== tool.name
                          ? "Another tool change for this session is still in flight."
                          : null);
                      return (
                        <ToolRow
                          key={`${tool.source}:${tool.name}`}
                          tool={tool}
                          pending={toolPending?.name === tool.name}
                          disabledReason={disabledReason}
                          ownReason={ownReason !== null}
                          mountLabel={mountLabel}
                          onToggle={(next) => toggleTool(tool.name, next)}
                        />
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {active === "mcp" && !drifted && (
        <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-xs text-ink-faint">
            {scopeCwd === null
              ? "Changes apply to new sessions in every project."
              : "Changes apply to new sessions in this project."}{" "}
            {live ? "Reload applies them to this session now." : ""}{" "}
            OAuth servers authenticate through omp's TUI: omp refuses reauth over rpc.
          </p>
          {live && tabId !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              tone="copper"
              disabled={reloading || (native && busy)}
              title={native && busy ? "wait for the current turn to finish" : "run /mcp reload in this session so it picks up the current MCP config"}
              onClick={reload}
            >
              {reloading ? "reloading…" : "reload MCP in this session"}
            </Button>
          )}
        </footer>
      )}
    </Modal>
  );
}
