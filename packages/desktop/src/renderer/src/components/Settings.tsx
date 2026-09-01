import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { OmpSettingValue } from "@omp-ui/core/types";
import { displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { useT, type MessageKey } from "../lib/i18n";
import { useStore, type SettingsPage } from "../store";
import { Modal } from "./ui";
import { AboutPage } from "./settings/AboutPage";
import { AppearancePage } from "./settings/AppearancePage";
import { GeneralFooter, GeneralPage } from "./settings/GeneralPage";
import { MemoryFooter, MemoryPage } from "./settings/MemoryPage";
import { OmpFooter, OmpPage } from "./settings/OmpPage";
import { ProvidersFooter, ProvidersPage } from "./settings/ProvidersPage";
import { RemoteFooter, RemotePage } from "./settings/RemotePage";
import { UpdatesFooter, UpdatesPage } from "./settings/UpdatesPage";
import type { FooterContext, Load } from "./settings/types";

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

interface PageContext {
  load: Load;
  projectCwd: string | null;
  pendingKey: string | null;
  writeError: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
  /** Snapshot reload counter; MemoryPage feeds it to its overview effect. */
  revision: number;
}

const PAGES: ReadonlyArray<{
  id: SettingsPage;
  labelKey: MessageKey;
  render: (ctx: PageContext) => ReactNode;
  footer?: ComponentType<FooterContext>;
}> = [
  { id: "general", labelKey: "settings.nav.general", render: () => <GeneralPage />, footer: GeneralFooter },
  { id: "appearance", labelKey: "settings.nav.appearance", render: () => <AppearancePage /> },
  { id: "updates", labelKey: "settings.nav.updates", render: () => <UpdatesPage />, footer: UpdatesFooter },
  { id: "remote", labelKey: "settings.nav.remote", render: () => <RemotePage />, footer: RemoteFooter },
  { id: "providers", labelKey: "settings.nav.providers", render: (ctx) => <ProvidersPage projectCwd={ctx.projectCwd} />, footer: ProvidersFooter },
  {
    id: "memory",
    labelKey: "settings.nav.memory",
    render: (ctx) => (
      <MemoryPage
        load={ctx.load}
        projectCwd={ctx.projectCwd}
        pendingKey={ctx.pendingKey}
        writeError={ctx.writeError}
        commit={ctx.commit}
        retry={ctx.retry}
        overviewRevision={ctx.revision}
      />
    ),
    footer: MemoryFooter,
  },
  {
    id: "omp",
    labelKey: "settings.nav.omp",
    render: (ctx) => (
      <OmpPage
        load={ctx.load}
        projectCwd={ctx.projectCwd}
        pendingKey={ctx.pendingKey}
        writeError={ctx.writeError}
        commit={ctx.commit}
        retry={ctx.retry}
      />
    ),
    footer: OmpFooter,
  },
  { id: "about", labelKey: "settings.nav.about", render: (ctx) => <AboutPage load={ctx.load} /> },
];

export function Settings() {
  const t = useT();
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

  const active = PAGES.find((p) => p.id === page);
  const Footer = active?.footer;
  const ctx: PageContext = {
    load,
    projectCwd,
    pendingKey,
    writeError,
    commit,
    retry: () => setReloadKey((k) => k + 1),
    revision: reloadKey,
  };

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
            {t("settings.shell.application")}
          </p>
          <h2
            id="settings-title"
            className="font-display text-base font-semibold text-ink"
          >
            {t("settings.shell.title")}
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
                {t(p.labelKey)}
              </button>
            ))}
          </nav>

          <div className="settings-body max-h-[30rem] min-w-0 flex-1 overflow-y-auto">
            {active !== undefined && active.render(ctx)}
          </div>
        </div>

        {Footer !== undefined && (
          <footer className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-ink-faint">
            <Footer agentDir={agentDir} anyLive={anyLive} />
          </footer>
        )}
      </section>
    </Modal>
  );
}
