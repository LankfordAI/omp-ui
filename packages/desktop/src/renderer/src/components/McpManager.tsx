import { useEffect, useRef, useState } from "react";
import type { McpServerEntry, McpServersResult } from "@omp-ui/core/types";
import type { McpRuntimeFailure } from "@omp-ui/core/mcp-status";
import { backend, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { findRecord, useStore } from "../store";
import { Button, Chip, Empty, Modal, Panel, Switch } from "./ui";

/**
 * The MCP management modal (issue #17): every server omp resolves for one
 * scope — a working tree (`scopeCwd`) or global (`null`, user-level sources
 * only) — with its effective enabled state. All resolution and mutation
 * lives in core — the renderer only ever sees the redacted DTO. The modal is
 * pinned to a tab (`tabId`) only when opened from a session.
 *
 * `scopeCwd` is the session's own working tree, not the project root it is
 * registered under: a worktree session's omp resolves project scope in its
 * checkout, so that is where the modal reads and writes (issue #325; the
 * checkout's `.omp/` is a symlink to the project's, so a native write still
 * lands on the project file).
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
 * answers without an agent turn), so the footer offers that rather than a
 * process restart. The store captures the scope cwd (+ tabId when
 * session-opened) at open time, so a focus change mid-edit cannot retarget a
 * toggle at another working tree.
 *
 * omp refuses `/mcp reauth` outside its own TUI, so http/sse rows in a live
 * pinned tab offer a handoff instead of a reauth button: the modal stages the
 * verb for an omp TUI in the tab's console drawer and closes (#243).
 */

type Load =
  | { status: "loading" }
  | { status: "loaded"; result: McpServersResult }
  | { status: "error"; message: string };

function Row({
  entry,
  projectScoped,
  failure,
  pending,
  onToggle,
  onAuthenticate,
}: {
  entry: McpServerEntry;
  failure?: McpRuntimeFailure;
  /** True when the modal is scoped to a working tree (`scopeCwd !== null`). */
  projectScoped: boolean;
  pending: boolean;
  onToggle: (entry: McpServerEntry, next: boolean) => void;
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
            <Chip tone="rose">disabled · {entry.disabledBy}</Chip>
          )}
          {!entry.effective && shadowedSource !== undefined && (
            <Chip tone="copper" title={entry.shadowedBy}>
              shadowed by {shadowedSource}
            </Chip>
          )}
          {entry.effective && failure !== undefined && (
            <Chip tone="rose">
              {failure.kind === "auth"
                ? "authentication failed in this session"
                : "connection failed in this session"}
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
          label={`${entry.state === "enabled" ? "disable" : "enable"} ${entry.name}`}
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

/**
 * Resolved MCP servers for one scope, with per-server toggles. The
 * presentational core of McpManager: load/error/empty states, per-file config
 * errors, the toggle pipeline, and per-row failure/reauth affordances.
 * `scopeCwd` is the working tree whose project-scope config decides — a
 * worktree session's checkout, else a project root — or `null` for global
 * scope. Session-scoped extras (reload, reauth handoff) engage only when a
 * live native `tabId` is pinned; the handoff reports back through
 * `onAuthenticated` so the owning dialog decides what to close.
 */
export function McpServersPanel({
  scopeCwd,
  tabId,
  onAuthenticated,
}: {
  scopeCwd: string | null;
  tabId?: string;
  onAuthenticated?: () => void;
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
  }, [scopeCwd, reloadKey]);

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

  return (
    <>
      {load.status === "loading" && (
        <Empty title="Resolving MCP servers…" hint="Reading omp's config sources." />
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
              <p className="mb-1 text-[11px] font-medium">
                {result.errors.length === 1
                  ? "One config file could not be read:"
                  : `${result.errors.length} config files could not be read:`}
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
          {result.servers.length === 0 ? (
            <Empty
              title={scopeCwd === null ? "No global MCP servers configured." : "No MCP servers configured for this project."}
              hint="omp resolves native .omp/mcp.json files plus translated cursor, claude, gemini, opencode, windsurf, and vscode configs."
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {result.servers.map((entry) => (
                <Row
                  key={`${entry.source}:${entry.sourcePath}:${entry.name}`}
                  entry={entry}
                  projectScoped={scopeCwd !== null}
                  pending={pendingName === entry.name}
                  failure={failures.get(entry.name)}
                  onToggle={toggle}
                  onAuthenticate={authenticate}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export function McpManager({ scopeCwd, tabId }: { scopeCwd: string | null; tabId?: string }) {
  const closeMcpManager = useStore((s) => s.closeMcpManager);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const record = useStore((s) => (tabId === undefined ? undefined : findRecord(s.state, tabId)));
  const live = record?.live === "live";
  const native = record?.mode === "rpc-ui";
  const worktree = record?.worktree ?? null;
  // A native tab mid-turn would queue the reload behind the running turn; a
  // PTY tab's TUI simply shows the typed line, so only the native path waits.
  const busy = useStore((s) => (tabId === undefined ? false : s.rpc[tabId]?.status === "running"));

  const [reloading, setReloading] = useState(false);

  const reload = (): void => {
    if (tabId === undefined) return;
    setReloading(true);
    const done = (): void => {
      setReloading(false);
      closeMcpManager();
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

  return (
    <Modal onClose={closeMcpManager} width="w-[40rem]">
      <section role="dialog" aria-modal="true" aria-labelledby="mcp-manager-title">
        <header className="border-b border-line px-4 py-3.5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            {scopeCwd === null ? "Global integrations" : "Project integrations"}
          </p>
          <h2 id="mcp-manager-title" className="font-display text-base font-semibold text-ink">
            MCP servers
          </h2>
          <p
            title={scopeCwd ?? undefined}
            className="mt-1 truncate font-mono text-[11px] text-ink-dim"
          >
            {scopeCwd ?? "Global — user-level configuration"}
          </p>
          {/* Names the directory the rows were resolved from, so a checkout's
              own tracked provider files (.cursor/mcp.json, opencode.json, …)
              differing from the project's is explainable, not mysterious. */}
          {worktree !== null && (
            <p
              className="mt-0.5 truncate font-mono text-[10px] text-ink-faint"
              title={record?.projectCwd}
            >
              ⎇ {worktree.branch} — resolved in this session&apos;s checkout, written through it to{" "}
              {record?.projectCwd}
            </p>
          )}
        </header>

        <div className="max-h-[24rem] overflow-y-auto">
          <McpServersPanel
            scopeCwd={scopeCwd}
            tabId={tabId}
            onAuthenticated={closeMcpManager}
          />
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-[11px] text-ink-faint">
            {scopeCwd === null
              ? "Changes apply to new sessions in every project."
              : "Changes apply to new sessions in this project."}{" "}
            {live ? "Reload applies them to this session now." : ""}{" "}
            OAuth servers authenticate through omp&apos;s TUI: omp refuses reauth over rpc.
          </p>
          {live && (
            <Button
              size="xs"
              variant="ghost"
              tone="copper"
              disabled={reloading || (native && busy)}
              title={
                native && busy
                  ? "wait for the current turn to finish"
                  : "run /mcp reload in this session so it picks up the current MCP config"
              }
              onClick={reload}
            >
              {reloading ? "reloading…" : "reload MCP in this session"}
            </Button>
          )}
        </footer>
      </section>
    </Modal>
  );
}