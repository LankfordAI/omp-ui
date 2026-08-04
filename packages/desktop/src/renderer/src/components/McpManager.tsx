import { useEffect, useRef, useState } from "react";
import type { McpServerEntry, McpServersResult } from "@omp-ui/core/types";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { findRecord, useStore } from "../store";
import { Button, Chip, Empty, Modal, Panel, Switch } from "./ui";

/**
 * The MCP management modal (issue #17): every server omp resolves for the
 * focused tab's project, with its effective enabled state, and toggles that
 * go through omp's own enable/disable write algorithm. All resolution and
 * mutation lives in core — the renderer only ever sees the redacted DTO.
 *
 * omp has no MCP RPC verbs and no config watching, so a toggle takes effect
 * on the next session spawn; the footer says so and offers an in-place
 * restart while the pinned tab is live. The modal is pinned to the tab it was
 * opened from (the store captures tabId + projectCwd at open time), so a
 * focus change mid-edit cannot retarget a toggle at another project.
 */

type Load =
  | { status: "loading" }
  | { status: "loaded"; result: McpServersResult }
  | { status: "error"; message: string };

/** ipcRenderer.invoke wraps main-process errors — unwrap for display (#16 precedent). */
function displayMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

function Row({
  entry,
  pending,
  onToggle,
}: {
  entry: McpServerEntry;
  pending: boolean;
  onToggle: (entry: McpServerEntry, next: boolean) => void;
}) {
  const shadowedSource = entry.shadowedBy?.split(":", 1)[0];
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
      {entry.effective && (
        <Switch
          on={entry.state === "enabled"}
          label={`${entry.state === "enabled" ? "disable" : "enable"} ${entry.name}`}
          title={
            entry.writable
              ? `writes enabled:${entry.state === "enabled" ? "false" : "true"} to ${entry.sourcePath}`
              : "tool-owned file — toggled via omp's user-level override lists"
          }
          disabled={pending}
          onChange={(next) => onToggle(entry, next)}
        />
      )}
    </li>
  );
}

export function McpManager({ tabId, projectCwd }: { tabId: string; projectCwd: string }) {
  const closeMcpManager = useStore((s) => s.closeMcpManager);
  const restartSession = useStore((s) => s.restartSession);
  const live = useStore((s) => findRecord(s.state, tabId)?.live === "live");

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [toggleError, setToggleError] = useState<string | null>(null);
  /** Name of the server with a toggle in flight; its switch stays disabled. */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    backend.getMcpServers(projectCwd).then(
      (result) => {
        if (g === gen.current) setLoad({ status: "loaded", result });
      },
      (err: unknown) => {
        if (g === gen.current) setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [projectCwd, reloadKey]);

  const toggle = (entry: McpServerEntry, next: boolean): void => {
    setPendingName(entry.name);
    setToggleError(null);
    backend
      .setMcpServerEnabled({
        projectCwd,
        name: entry.name,
        // Tool-owned files are never mutated; the toggle goes through omp's
        // user-level override lists instead (see core/mcp-config.ts).
        sourcePath: entry.writable ? entry.sourcePath : undefined,
        enabled: next,
      })
      .then(
        (result) => setLoad({ status: "loaded", result }),
        (err: unknown) => setToggleError(displayMessage(err)),
      )
      .finally(() => setPendingName(null));
  };

  const restart = (): void => {
    setRestarting(true);
    void restartSession(tabId).then((ok) => {
      setRestarting(false);
      // The relaunch recycles the process and transcript, so any lingering
      // modal state would be stale; a failure keeps the modal open.
      if (ok) closeMcpManager();
    });
  };

  const result = load.status === "loaded" ? load.result : null;

  return (
    <Modal onClose={closeMcpManager} width="w-[40rem]">
      <section role="dialog" aria-modal="true" aria-labelledby="mcp-manager-title">
        <header className="border-b border-line px-4 py-3.5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            Session integrations
          </p>
          <h2 id="mcp-manager-title" className="font-display text-base font-semibold text-ink">
            MCP servers
          </h2>
          <p title={projectCwd} className="mt-1 truncate font-mono text-[11px] text-ink-dim">
            {projectCwd}
          </p>
        </header>

        <div className="max-h-[24rem] overflow-y-auto">
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
                  title="No MCP servers configured for this project."
                  hint="omp resolves native .omp/mcp.json files plus translated cursor, claude, gemini, opencode, windsurf, and vscode configs."
                />
              ) : (
                <ul className="divide-y divide-line-soft">
                  {result.servers.map((entry) => (
                    <Row
                      key={`${entry.source}:${entry.sourcePath}:${entry.name}`}
                      entry={entry}
                      pending={pendingName === entry.name}
                      onToggle={toggle}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-[11px] text-ink-faint">Changes apply to new sessions.</p>
          {live && (
            <Button
              size="xs"
              variant="ghost"
              tone="copper"
              disabled={restarting}
              title="kill and --resume this session so it picks up the current MCP config"
              onClick={restart}
            >
              {restarting ? "restarting…" : "restart session to apply"}
            </Button>
          )}
        </footer>
      </section>
    </Modal>
  );
}
