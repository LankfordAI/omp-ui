import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpServerEntry, McpServersResult } from "@omp-ui/core/types";
import type { McpRuntimeFailure } from "@omp-ui/core/mcp-status";
import type {
  CapabilityReason,
  CapabilitySectionId,
  CapabilitySkill,
  CapabilityTool,
} from "@omp-ui/core/capabilities";
import { backend, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { fuzzyBest } from "../lib/fuzzy";
import { useT, type MessageKey } from "../lib/i18n";
import { findRecord, sessionCwd, useStore } from "../store";
import { Button, Chip, ChoiceCapsule, Empty, IconButton, Modal, Panel, Switch } from "./ui";

/**
 * The session-capabilities viewer (issue #374): one modal, three categories —
 * MCP servers (resolved config), Skills, and Tools (the loaded rosters a live
 * native session publishes through the generated capabilities bridge).
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
 * Skills and Tools describe the selected live native session's loaded roster
 * — never a machine-wide catalog. An unavailable section says why; it is
 * never rendered as an empty list.
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
  const t = useT();
  const shadowedSource = entry.shadowedBy?.split(":", 1)[0];
  // Exactly the states the project writer rejects: nothing project-local can
  // beat the user denylist or a user-level source's enabled:false.
  const pinnedGlobally =
    projectScoped &&
    entry.state === "disabled" &&
    (entry.disabledBy === "denylist" || entry.scope === "user");
  const inPlaceTitle = t("mcp.row.inPlace", {
    state: entry.state === "enabled" ? "false" : "true",
    path: entry.sourcePath,
  });
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
            <Chip tone="rose">{t("mcp.row.disabled", { reason: entry.disabledBy ?? "" })}</Chip>
          )}
          {!entry.effective && shadowedSource !== undefined && (
            <Chip tone="copper" title={entry.shadowedBy}>
              {t("mcp.row.shadowed", { source: shadowedSource })}
            </Chip>
          )}
          {/* Liveness is the only colored fact here: rose fails, signal
              connects, everything else stays neutral — including "unknown". */}
          {entry.effective && failure !== undefined && (
            <Chip tone="rose">
              {failure.kind === "auth"
                ? t("mcp.row.authFailed")
                : t("mcp.row.connectFailed")}
            </Chip>
          )}
          {entry.effective && failure === undefined && status !== undefined && (
            <Chip tone={status === "connected" ? "signal" : "neutral"}>
              {status === "connected"
                ? t("viewer.mcp.statusConnected")
                : status === "pending"
                  ? t("viewer.mcp.statusPending")
                  : t("viewer.mcp.statusUnknown")}
            </Chip>
          )}
        </div>
        <span
          title={entry.endpoint}
          className="mt-0.5 block truncate font-mono text-[11px] tabular-nums text-ink-mid"
        >
          {entry.endpoint || "—"}
        </span>
        <span
          title={entry.sourcePath}
          className="block truncate text-[10px] text-ink-faint"
        >
          {entry.source} · {entry.scope}
        </span>
      </div>
      {entry.effective && toolsCount !== null && toolsCount > 0 && onInspectTools !== undefined && (
        <Button size="xs" variant="ghost" onClick={() => onInspectTools(entry.name)}>
          {t("viewer.mcp.registeredTools", { count: toolsCount })}
        </Button>
      )}
      {entry.effective && entry.transport !== "stdio" && onAuthenticate !== undefined && (
        <Button
          size="xs"
          variant="ghost"
          title={t("mcp.reauth.handoff")}
          onClick={() => onAuthenticate(entry)}
        >
          {t("mcp.reauth.button")}
        </Button>
      )}
      {entry.effective && (
        <Switch
          on={entry.state === "enabled"}
          label={
            entry.state === "enabled"
              ? t("mcp.row.toggleDisable", { name: entry.name })
              : t("mcp.row.toggleEnable", { name: entry.name })
          }
          title={
            projectScoped
              ? pinnedGlobally
                ? t("mcp.row.pinnedUser")
                : entry.enabledBy === "allowlist"
                  ? entry.disableReach === "global"
                    ? t("mcp.row.allowlistGlobal")
                    : t("mcp.row.allowlistProject")
                  : entry.scope === "project" && entry.writable
                    ? inPlaceTitle
                    : t("mcp.row.projectOverride")
              : entry.writable
                ? inPlaceTitle
                : t("mcp.row.toolOwned")
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
  const t = useT();
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-ink">{name}</span>
          <Chip mono>mcp</Chip>
          <Chip tone={status === "connected" ? "signal" : status === "failed" ? "rose" : "neutral"}>
            {status === "connected"
              ? t("viewer.mcp.statusConnected")
              : status === "pending"
                ? t("viewer.mcp.statusPending")
                : status === "unknown"
                  ? t("viewer.mcp.statusUnknown")
                  : t("mcp.row.connectFailed")}
          </Chip>
        </div>
      </div>
      {toolsCount !== null && toolsCount > 0 && onInspectTools !== undefined && (
        <Button size="xs" variant="ghost" onClick={() => onInspectTools(name)}>
          {t("viewer.mcp.registeredTools", { count: toolsCount })}
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
  tabId,
  onAuthenticated,
  query,
  runtimeTools,
  onInspectTools,
  refreshKey,
  onCounts,
}: {
  scopeCwd: string | null;
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
  const t = useT();

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
    backend.getMcpServers(scopeCwd).then(
      (result) => {
        if (g === gen.current) setLoad({ status: "loaded", result });
      },
      (err: unknown) => {
        if (g === gen.current) setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [scopeCwd, reloadKey, refreshKey]);

  const toggle = (entry: McpServerEntry, next: boolean): void => {
    setPendingName(entry.name);
    setToggleError(null);
    backend
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
    return [...names]
      .filter((name) => !named.has(name) && scoreFields(needle, name, "", "") !== null)
      .sort((a, b) => a.localeCompare(b));
  }, [result, mcpStatus, runtimeTools, needle]);

  const totalCount = result === null ? null : result.servers.length + runtimeOnly.length;
  const visibleCount = configRows === null ? 0 : configRows.length + runtimeOnly.length;
  useEffect(() => {
    onCounts?.(visibleCount, totalCount);
  }, [onCounts, visibleCount, totalCount]);

  const filterable = refreshKey !== undefined;

  return (
    <>
      {load.status === "loading" && (
        <Empty
          title={t("mcp.panel.loading")}
          hint={t("mcp.panel.loadingHint")}
        />
      )}
      {load.status === "error" && (
        <Empty
          title={t("mcp.panel.error")}
          hint={load.message}
          action={
            <Button size="xs" onClick={() => setReloadKey((k) => k + 1)}>
              {t("mcp.panel.retry")}
            </Button>
          }
        />
      )}
      {result !== null && (
        <div className="py-1.5">
          {result.errors.length > 0 && (
            <Panel tone="rose" className="mx-4 my-2 px-3 py-2">
              <p className="mb-1 text-[11px] font-medium">
                {result.errors.length === 1
                  ? t("mcp.panel.configErrorOne")
                  : t("mcp.panel.configErrorMany", { count: result.errors.length })}
              </p>
              {result.errors.map((e) => (
                <p key={e.path} className="truncate font-mono text-[10px]" title={e.path}>
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
                label={t("viewer.mcp.filterLabel")}
                value={stateFilter}
                onChange={setStateFilter}
                options={[
                  { value: "all", label: t("viewer.filter.all") },
                  { value: "enabled", label: t("viewer.filter.enabled") },
                  { value: "disabled", label: t("viewer.filter.disabled") },
                ]}
              />
            </div>
          )}
          {result.servers.length === 0 ? (
            <Empty
              title={
                scopeCwd === null
                  ? t("mcp.panel.emptyGlobal")
                  : t("mcp.panel.emptyProject")
              }
              hint={t("mcp.panel.emptyHint")}
            />
          ) : configRows !== null && configRows.length === 0 && runtimeOnly.length === 0 ? (
            <Empty title={t("viewer.empty.noMatches")} />
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
              {runtimeOnly.length > 0 && (
                <div className="mt-1.5">
                  <p className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    {t("viewer.mcp.runtimeOnly")}
                  </p>
                  <ul className="divide-y divide-line-soft border-t border-line-soft">
                    {runtimeOnly.map((name) => (
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

function SkillRow({ skill }: { skill: CapabilitySkill }) {
  const t = useT();
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-ink">{skill.name}</span>
        <Chip>{t("viewer.skills.loaded")}</Chip>
        {skill.hidden === true && <Chip>{t("viewer.skills.hidden")}</Chip>}
        {skill.source !== null && <Chip mono>{skill.source}</Chip>}
      </div>
      {skill.description.length > 0 && (
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-mid">
          {skill.description}
          {skill.descriptionTruncated && (
            <span className="text-ink-faint"> {t("viewer.row.truncated")}</span>
          )}
        </p>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-ink-faint">{t("viewer.row.details")}</summary>
        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-dim" title={skill.filePath}>
          {skill.filePath}
        </p>
        {skill.hidden === null && (
          <p className="text-[10px] text-ink-faint">{t("viewer.skills.hiddenUnknown")}</p>
        )}
      </details>
    </li>
  );
}

const TOOL_SOURCE_KEYS: Record<CapabilityTool["source"], MessageKey> = {
  builtin: "viewer.tools.originBuiltin",
  extension: "viewer.tools.originExtension",
  mcp: "viewer.tools.originMcp",
  sdk: "viewer.tools.originSdk",
  unknown: "viewer.tools.originUnknown",
};

/** Unavailable-section reasons, mapped to their explanation keys. */
const REASON_KEYS: Record<CapabilityReason, MessageKey> = {
  "missing-api": "viewer.reason.missingApi",
  "read-failed": "viewer.reason.readFailed",
  "payload-too-large": "viewer.reason.payloadTooLarge",
};

function ToolRow({ tool }: { tool: CapabilityTool }) {
  const t = useT();
  const access: string[] = [];
  if (tool.direct === null) access.push(t("viewer.tools.direct"));
  if (tool.xdev === null) access.push(t("viewer.tools.xdev"));
  if (tool.evalBridge === null) access.push(t("viewer.tools.eval"));
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-ink">{tool.name}</span>
        <Chip mono>{t(TOOL_SOURCE_KEYS[tool.source])}</Chip>
        <Chip>
          {tool.enabled === true
            ? t("viewer.tools.enabled")
            : tool.enabled === false
              ? t("viewer.tools.notEnabled")
              : t("viewer.state.unknown")}
        </Chip>
        {/* Access paths: shown when true, absent when false — never a
            "disabled" label for a tool that is reachable via xd:// or the
            eval bridge instead of the model. Null is its own chip. */}
        {tool.direct === true && <Chip>{t("viewer.tools.direct")}</Chip>}
        {tool.direct === null && (
          <Chip title={t("viewer.tools.fieldUnknown", { field: t("viewer.tools.direct") })}>
            {t("viewer.tools.fieldUnknown", { field: t("viewer.tools.direct") })}
          </Chip>
        )}
        {tool.xdev === true && <Chip>{t("viewer.tools.xdev")}</Chip>}
        {tool.xdev === null && (
          <Chip title={t("viewer.tools.fieldUnknown", { field: t("viewer.tools.xdev") })}>
            {t("viewer.tools.fieldUnknown", { field: t("viewer.tools.xdev") })}
          </Chip>
        )}
        {tool.evalBridge === true && <Chip>{t("viewer.tools.eval")}</Chip>}
        {tool.evalBridge === null && (
          <Chip title={t("viewer.tools.fieldUnknown", { field: t("viewer.tools.eval") })}>
            {t("viewer.tools.fieldUnknown", { field: t("viewer.tools.eval") })}
          </Chip>
        )}
        {tool.mcpServerName !== null && <Chip mono>{tool.mcpServerName}</Chip>}
      </div>
      {tool.description.length > 0 && (
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-mid">
          {tool.description}
          {tool.descriptionTruncated && (
            <span className="text-ink-faint"> {t("viewer.row.truncated")}</span>
          )}
        </p>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-ink-faint">{t("viewer.row.details")}</summary>
        {tool.sourcePath !== null && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-ink-dim" title={tool.sourcePath}>
            {tool.sourcePath}
          </p>
        )}
        {tool.mcpServerName !== null && (
          <p className="font-mono text-[10px] text-ink-dim">
            {tool.mcpServerName}
            {tool.mcpToolName !== null ? ` · ${tool.mcpToolName}` : ""}
          </p>
        )}
        {access.length > 0 && (
          <p className="text-[10px] text-ink-faint">
            {t("viewer.tools.notReported", { fields: access.join(", ") })}
          </p>
        )}
      </details>
    </li>
  );
}

export function CapabilitiesViewer({
  scopeCwd,
  tabId,
  section = "mcp",
}: {
  scopeCwd: string | null;
  tabId?: string;
  section?: CapabilitySectionId;
}) {
  const closeCapabilitiesViewer = useStore((s) => s.closeCapabilitiesViewer);
  const refreshCapabilities = useStore((s) => s.refreshCapabilities);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const state = useStore((s) => s.state);
  const record = useStore((s) => (tabId === undefined ? undefined : findRecord(s.state, tabId)));
  const live = record?.live === "live";
  const native = record?.mode === "rpc-ui";
  const worktree = record?.worktree ?? null;
  // A native tab mid-turn would queue the reload behind the running turn; a
  // PTY tab's TUI simply shows the typed line, so only the native path waits.
  const busy = useStore((s) => (tabId === undefined ? false : s.rpc[tabId]?.status === "running"));
  // Skills/Tools describe one live native session. No pin, no bridge.
  const loadStatus = useStore((s) =>
    tabId === undefined ? ("bridge-unavailable" as const) : (s.rpc[tabId]?.capabilitiesLoad ?? "idle"),
  );
  const snapshot = useStore((s) => (tabId === undefined ? null : (s.rpc[tabId]?.capabilities ?? null)));
  const t = useT();

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
  const [mcpCounts, setMcpCounts] = useState<{ visible: number; total: number | null } | null>(null);
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
    tabId !== undefined && record !== undefined && effectiveCwd !== undefined && effectiveCwd !== scopeCwd;
  const missingSession =
    tabId !== undefined && record === undefined && state !== null && !drifted;
  // The last-known snapshot rides an error load too (Retry offered, stale
  // labeled); a drifted pin detaches it entirely.
  const roster =
    !drifted && !missingSession && snapshot !== null && (loadStatus === "available" || loadStatus === "error")
      ? snapshot
      : null;
  const sessionTools = roster !== null && roster.tools.status === "available" ? roster.tools.items : null;

  const reload = (): void => {
    if (tabId === undefined) return;
    setReloading(true);
    const done = (): void => {
      setReloading(false);
      closeCapabilitiesViewer();
    };
    if (native) {
      // omp handles /mcp reload itself (disconnectAll -> discoverAndConnect ->
      // refreshMCPTools) and answers agentInvoked:false — no model turn. The
      // command row in the transcript is the receipt, including on failure.
      void runSlashCommand(tabId, "/mcp reload").then(done, done);
    } else {
      // A terminal tab is an omp TUI: type the command the user would type.
      backend.ptyWrite(tabId, "/mcp reload\r");
      done();
    }
  };

  /** Re-read config from disk and ask the bridge for a fresh snapshot. This
   *  never sends `/reload` or `/mcp reload` — it mutates no session. */
  const refresh = (): void => {
    setRefreshKey((k) => k + 1);
    if (tabId !== undefined && !drifted) void refreshCapabilities(tabId).catch(() => {});
  };

  const reportMcpCounts = useCallback((visible: number, total: number | null) => {
    setMcpCounts((prev) =>
      prev !== null && prev.visible === visible && prev.total === total ? prev : { visible, total },
    );
  }, []);

  const openToolsFor = useCallback((serverName: string) => {
    // The drill-down answers one question — what does THIS server register?
    // — so every filter that could hide the answer goes.
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
      const score = scoreFields(needle, skill.name, skill.description, `${skill.source ?? ""} ${skill.filePath} ${skill.scope ?? ""}`);
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

  const TABS: { id: CapabilitySectionId; label: string }[] = [
    { id: "mcp", label: t("viewer.tab.mcp") },
    { id: "skills", label: t("viewer.tab.skills") },
    { id: "tools", label: t("viewer.tab.tools") },
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
    if (drifted) return <Empty title={t("viewer.state.detached")} />;
    if (missingSession) return <Empty title={t("viewer.state.missingSession")} />;
    switch (loadStatus) {
      case "idle":
      case "loading":
        return <Empty title={t("viewer.state.loading")} hint={t("viewer.state.loadingHint")} />;
      case "starting":
        return <Empty title={t("viewer.state.starting")} />;
      case "bridge-unavailable":
        return <Empty title={t("viewer.state.bridgeUnavailable")} hint={t("viewer.state.bridgeUnavailableHint")} />;
      case "terminal":
        return <Empty title={t("viewer.state.terminal")} />;
      case "not-live":
        return <Empty title={t("viewer.state.notLive")} />;
      case "missing-session":
        return <Empty title={t("viewer.state.missingSession")} />;
      case "error":
        return (
          <Empty
            title={t("viewer.state.error")}
            action={
              <Button size="xs" onClick={refresh}>
                {t("viewer.actions.retry")}
              </Button>
            }
          />
        );
      default:
        // "available" with no snapshot yet is the same read-in-flight state.
        return <Empty title={t("viewer.state.loading")} hint={t("viewer.state.loadingHint")} />;
    }
  };

  const skillTotal = roster !== null && roster.skills.status === "available" ? roster.skills.items.length : null;
  const toolTotal = roster !== null && roster.tools.status === "available" ? roster.tools.items.length : null;

  return (
    <Modal onClose={closeCapabilitiesViewer} width="w-[42rem]" labelledBy="capabilities-viewer-title">
      <header className="border-b border-line px-4 py-3.5">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {scopeCwd === null ? t("viewer.header.globalKicker") : t("viewer.header.projectKicker")}
        </p>
        <h2 id="capabilities-viewer-title" className="font-display text-base font-semibold text-ink">
          {t("viewer.header.title")}
        </h2>
        {record !== undefined && record.title.length > 0 && (
          <p className="mt-0.5 truncate text-xs text-ink-mid">{t("viewer.header.session", { title: record.title })}</p>
        )}
        <p title={scopeCwd ?? undefined} className="mt-1 truncate font-mono text-[11px] text-ink-dim">
          {scopeCwd ?? t("viewer.header.globalPath")}
        </p>
        {/* Names the directory the rows were resolved from, so a checkout's
            own tracked provider files (.cursor/mcp.json, opencode.json, …)
            differing from the project's is explainable, not mysterious. */}
        {worktree !== null && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={record?.projectCwd}>
            ⎇ {worktree.branch}{t("mcp.header.worktree", { cwd: record?.projectCwd ?? "" })}
          </p>
        )}
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{t("viewer.header.coverage")}</p>
      </header>

      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div role="tablist" aria-label={t("viewer.header.title")} onKeyDown={onTabListKeyDown} className="flex gap-1">
          {TABS.map((tab) => {
            const selected = tab.id === active;
            const count =
              tab.id === "mcp"
                ? countLabel(mcpCounts?.total ?? null, mcpCounts?.visible ?? null)
                : tab.id === "skills"
                  ? countLabel(skillTotal, skillRows?.length ?? null)
                  : countLabel(toolTotal, toolRows?.length ?? null);
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
                <span className="font-mono text-[10px] tabular-nums text-ink-faint">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            data-modal-initial-focus
            type="search"
            aria-label={t("viewer.search.label")}
            placeholder={t("viewer.search.label")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-6 w-44 rounded-md border border-line bg-raised px-2 text-xs text-ink placeholder:text-ink-faint"
          />
          <Button size="xs" variant="ghost" title={t("viewer.actions.refreshTitle")} onClick={refresh}>
            {t("viewer.actions.refresh")}
          </Button>
        </div>
      </div>

      {drifted && (
        <Panel tone="copper" className="mx-4 my-2 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-ink-mid">{t("viewer.banner.detached", { cwd: scopeCwd ?? t("viewer.header.globalPath") })}</p>
        </Panel>
      )}
      {loadStatus === "error" && roster !== null && (
        <Panel tone="copper" className="mx-4 my-2 px-3 py-2">
          <p className="flex items-center gap-2 text-[11px] text-ink-mid">
            {t("viewer.banner.lastKnown")}
            <Button size="xs" onClick={refresh}>
              {t("viewer.actions.retry")}
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
            tabId={drifted ? undefined : tabId}
            onAuthenticated={closeCapabilitiesViewer}
            query={query}
            runtimeTools={sessionTools}
            onInspectTools={openToolsFor}
            refreshKey={refreshKey}
            onCounts={reportMcpCounts}
          />
        )}
        {active === "skills" && (
          <>
            {roster === null && liveUnavailable()}
            {roster !== null && roster.skills.status === "unavailable" && (
              <Empty title={t(REASON_KEYS[roster.skills.reason])} hint={t("viewer.skills.unavailableHint")} />
            )}
            {roster !== null && roster.skills.status === "available" && (
              <div className="py-1.5">
                <div className="flex items-center gap-2 px-4 pb-1">
                  <ChoiceCapsule
                    label={t("viewer.skills.filterLabel")}
                    value={skillView}
                    onChange={setSkillView}
                    options={[
                      { value: "all", label: t("viewer.filter.all") },
                      { value: "listed", label: t("viewer.skills.filterListed") },
                      { value: "hidden", label: t("viewer.skills.filterHidden") },
                      { value: "unknown", label: t("viewer.filter.unknown") },
                    ]}
                  />
                </div>
                <p className="px-4 py-1 text-[11px] text-ink-faint">
                  {t("viewer.skills.commands", {
                    state:
                      roster.skillCommandsEnabled === true
                        ? t("viewer.skills.stateEnabled")
                        : roster.skillCommandsEnabled === false
                          ? t("viewer.skills.stateDisabled")
                          : t("viewer.state.unknown"),
                  })}
                </p>
                <p className="px-4 py-1 text-[11px] leading-relaxed text-ink-faint">{t("viewer.skills.coverage")}</p>
                {skillRows !== null && skillRows.length === 0 && (
                  <Empty
                    title={roster.skills.items.length === 0 ? t("viewer.empty.none") : t("viewer.empty.noMatches")}
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
        {active === "tools" && (
          <>
            {roster === null && liveUnavailable()}
            {roster !== null && roster.tools.status === "unavailable" && (
              <Empty title={t(REASON_KEYS[roster.tools.reason])} hint={t("viewer.tools.unavailableHint")} />
            )}
            {roster !== null && roster.tools.status === "available" && (
              <div className="py-1.5">
                <div className="flex flex-wrap items-center gap-2 px-4 pb-1.5">
                  <ChoiceCapsule
                    label={t("viewer.tools.statusFilter")}
                    value={toolStatus}
                    onChange={setToolStatus}
                    options={[
                      { value: "all", label: t("viewer.filter.all") },
                      { value: "enabled", label: t("viewer.tools.enabled") },
                      { value: "disabled", label: t("viewer.tools.notEnabled") },
                      { value: "unknown", label: t("viewer.filter.unknown") },
                    ]}
                  />
                  <select
                    aria-label={t("viewer.tools.originFilter")}
                    value={toolOrigin}
                    onChange={(e) => setToolOrigin(e.target.value as "all" | CapabilityTool["source"])}
                    className="h-6 rounded-md border border-line bg-raised px-1.5 text-[11px] text-ink-mid"
                  >
                    <option value="all">{t("viewer.tools.originAll")}</option>
                    <option value="builtin">{t("viewer.tools.originBuiltin")}</option>
                    <option value="extension">{t("viewer.tools.originExtension")}</option>
                    <option value="mcp">{t("viewer.tools.originMcp")}</option>
                    <option value="sdk">{t("viewer.tools.originSdk")}</option>
                    <option value="unknown">{t("viewer.tools.originUnknown")}</option>
                  </select>
                  {toolServer !== null && (
                    <span className="flex items-center gap-1">
                      <Chip mono title={toolServer}>{toolServer}</Chip>
                      <IconButton
                        label={t("viewer.tools.clearServer", { server: toolServer })}
                        onClick={() => setToolServer(null)}
                      >
                        ×
                      </IconButton>
                    </span>
                  )}
                </div>
                {toolRows !== null && toolRows.length === 0 && (
                  <Empty
                    title={roster.tools.items.length === 0 ? t("viewer.empty.none") : t("viewer.empty.noMatches")}
                  />
                )}
                {toolRows !== null && toolRows.length > 0 && (
                  <ul className="divide-y divide-line-soft">
                    {toolRows.map((tool) => (
                      <ToolRow key={`${tool.source}:${tool.name}`} tool={tool} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {active === "mcp" && !drifted && (
        <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-[11px] text-ink-faint">
            {scopeCwd === null
              ? t("mcp.footer.global")
              : t("mcp.footer.project")}{" "}
            {live ? t("mcp.footer.reload") : ""}{" "}
            {t("mcp.footer.oauth")}
          </p>
          {live && tabId !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              tone="copper"
              disabled={reloading || (native && busy)}
              title={native && busy ? t("mcp.reload.titleBusy") : t("mcp.reload.title")}
              onClick={reload}
            >
              {reloading ? t("mcp.reload.loading") : t("mcp.reload.label")}
            </Button>
          )}
        </footer>
      )}
    </Modal>
  );
}
