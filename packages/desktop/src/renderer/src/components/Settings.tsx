import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OmpSettingValue } from "@omp-ui/core/types";
import { displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { useStore, type SettingsPage } from "../store";
import { Modal } from "./ui";
import { AboutPage } from "./settings/AboutPage";
import { AppearancePage } from "./settings/AppearancePage";
import { GeneralPage } from "./settings/GeneralPage";
import { MemoryPage } from "./settings/MemoryPage";
import { OmpPage } from "./settings/OmpPage";
import { ProvidersPage } from "./settings/ProvidersPage";
import { RemotePage } from "./settings/RemotePage";
import { UpdatesPage } from "./settings/UpdatesPage";
import type { Load } from "./settings/types";

/**
 * The settings modal (issue #36): eight pages behind one store-driven nav
 * (`settingsPage`), so callers can deep-link a page. The page bodies live in
 * the `./settings` modules; this file is the shell — the nav table, the
 * snapshot load, the commit wiring, and the modal chrome. The omp and Memory
 * pages are schema-driven GUIs over a curated allowlist of omp's own
 * settings, written through `omp config set` and re-read after every write —
 * the snapshot is the single source of truth for values AND layer badges (a
 * first write legitimately flips a badge from `default` to `global`), so
 * nothing is patched optimistically.
 *
 * The snapshot is loaded once here rather than per page: omp, Memory, and
 * About consume it, and it costs four omp invocations.
 */

const PAGES: ReadonlyArray<{ id: SettingsPage; label: string }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "updates", label: "Updates" },
  { id: "remote", label: "Remote access" },
  { id: "providers", label: "Providers" },
  { id: "memory", label: "Memory" },
  { id: "omp", label: "omp" },
  { id: "about", label: "About" },
];

export function Settings() {
  const page = useStore((s) => s.settingsPage) ?? "general";
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const readOmpSettings = useStore((s) => s.readOmpSettings);
  const writeOmpSetting = useStore((s) => s.writeOmpSetting);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const anyLive = useStore(
    (s) =>
      s.state?.projects.some((g) =>
        g.sessions.some((x) => x.live === "live"),
      ) ?? false,
  );

  const projectCwd =
    tabs.find((t) => t.tabId === activeTabId)?.projectCwd ?? null;

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  /** Key of the setting with a write in flight; its control stays disabled. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    readOmpSettings(projectCwd).then(
      (snapshot) => {
        if (g === gen.current) setLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => {
        if (g === gen.current)
          setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [readOmpSettings, projectCwd, reloadKey]);

  const commit = (key: string, value: OmpSettingValue): void => {
    setPendingKey(key);
    writeOmpSetting(key, value)
      .then(
        () => {
          setWriteError(null);
          // The re-read is the single source of truth for values and layer
          // badges — nothing is patched optimistically.
          setReloadKey((k) => k + 1);
        },
        (err: unknown) => setWriteError(displayMessage(err)),
      )
      .finally(() => setPendingKey(null));
  };

  const agentDir = load.status === "loaded" ? load.snapshot.agentDir : null;

  let footer: ReactNode = null;
  if (page === "general") {
    footer = (
      <p>
        Default session and agent modes apply to new sessions; everything else
        applies immediately.
      </p>
    );
  } else if (page === "updates") {
    // Auto-download is deliberately absent: both download paths end in an
    // installer launch or an app restart.
    footer = <p>Downloads always need a click.</p>;
  } else if (page === "remote") {
    // Load-bearing honesty: installability and offline are secure-context-only, so a plain
    // http://<lan-ip> origin cannot have them no matter what the manifest says.
    footer = (
      <p>
        Over localhost the app is a full browser app. Over your local network it
        works as a responsive web app, but browsers reserve installability and
        offline support for secure origins — plain{" "}
        <span className="font-mono">http://&lt;lan-ip&gt;</span> is not one, so
        there is no install prompt until you front this with your own HTTPS (a
        TLS terminator, or Tailscale serve). Changing anything here restarts
        only the server; sessions keep running.
      </p>
    );
  } else if (page === "providers") {
    // Load-bearing: keys bind at process start, and a GUI launch inherits none
    // of the user's shell exports — the two facts that make this page exist.
    footer = (
      <p>
        omp reads credentials from the environment, so omp-ui supplies these to
        every session it launches — a key added here takes effect on the next
        session spawn.
        {anyLive && " Restart a session from its MCP panel to apply now."} Keys
        already exported by your shell profile are picked up automatically, and
        a project&apos;s <span className="font-mono">.env</span> is loaded by
        omp itself, so both are shown here but neither needs re-entering.
      </p>
    );
  } else if (page === "memory") {
    footer = (
      <p>
        Writes go to omp&apos;s global config (
        <span className="font-mono">{agentDir ?? "…"}/config.yml</span>); a
        project&apos;s <span className="font-mono">.omp/config.yml</span> can win
        and is shown as <span className="font-mono">project</span>. Memory
        configuration applies to sessions started after the change.
      </p>
    );
  } else if (page === "omp") {
    // Load-bearing per ADR-0005: where writes land, which layer wins, and when
    // they take effect. omp regenerates its YAML on write, so hand-written
    // comments in config.yml do not survive an edit from here.
    footer = (
      <p>
        Writes go to omp&apos;s global config (
        <span className="font-mono">{agentDir ?? "…"}/config.yml</span>); a
        project&apos;s <span className="font-mono">.omp/config.yml</span> still
        wins and is shown as <span className="font-mono">project</span>. omp
        binds model roles and the advisor at process start — changes take effect
        on the next session spawn.
        {anyLive && " Restart a session from its MCP panel to apply now."} omp
        regenerates its YAML on write, so comments in config.yml are dropped.
      </p>
    );
  }

  return (
    <Modal onClose={closeSettings} width="w-[46rem]">
      <section
        className="settings-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-header border-b border-line px-4 py-3.5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            Application
          </p>
          <h2
            id="settings-title"
            className="font-display text-base font-semibold text-ink"
          >
            Settings
          </h2>
        </header>

        <div className="settings-layout flex">
          <nav className="settings-nav w-40 shrink-0 space-y-px border-r border-line p-1.5">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-current={page === p.id ? "page" : undefined}
                onClick={() => openSettings(p.id)}
                className={cn(
                  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors duration-150",
                  "hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none",
                  page === p.id ? "bg-hover text-ink" : "text-ink-mid",
                )}
              >
                {p.label}
              </button>
            ))}
          </nav>

          <div className="settings-body max-h-[30rem] min-w-0 flex-1 overflow-y-auto">
            {page === "general" && <GeneralPage />}
            {page === "appearance" && <AppearancePage />}
            {page === "updates" && <UpdatesPage />}
            {page === "remote" && <RemotePage />}
            {page === "providers" && <ProvidersPage projectCwd={projectCwd} />}
            {page === "memory" && (
              <MemoryPage
                load={load}
                projectCwd={projectCwd}
                pendingKey={pendingKey}
                writeError={writeError}
                commit={commit}
                retry={() => setReloadKey((revision) => revision + 1)}
                overviewRevision={reloadKey}
              />
            )}
            {page === "omp" && (
              <OmpPage
                load={load}
                projectCwd={projectCwd}
                pendingKey={pendingKey}
                writeError={writeError}
                commit={commit}
                retry={() => setReloadKey((k) => k + 1)}
              />
            )}
            {page === "about" && <AboutPage load={load} />}
          </div>
        </div>

        {footer !== null && (
          <footer className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-ink-faint">
            {footer}
          </footer>
        )}
      </section>
    </Modal>
  );
}
