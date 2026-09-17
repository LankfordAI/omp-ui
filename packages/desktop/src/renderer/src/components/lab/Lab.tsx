import { useEffect } from "react";
import type { ProjectGroup } from "@omp-ui/core/types";
import { experimentSession } from "../../lib/experiment-link";
import { useT } from "../../lib/i18n";
import { projectKey } from "../../lib/project-key";
import { useStore } from "../../store";
import type { LabView } from "../../store/types";
import { Button, IconButton, IconClose, IconRefresh, Label } from "../ui";
import { ExperimentCard, PendingExperimentCard } from "./ExperimentCard";
import { ExperimentDetail } from "./ExperimentDetail";
import { experimentState } from "./experiment-state";

/** One project the Lab can scope to, on this app or a joined instance. */
interface ScopedProject {
  key: string;
  instanceId: string | null;
  /** The instance nickname in front of a remote project's name, like tab labels. */
  label: string;
  group: ProjectGroup;
}

const EMPTY_SCOPE: readonly ScopedProject[] = [];

/**
 * The Lab (CONTEXT.md, issue #559): every experiment omp's autoresearch DBs
 * hold for the scoped projects, one card per row, with the detail of one
 * experiment when `view.experiment` is set. It takes the main pane in place
 * of the tabs — never a tab itself — and reads only: the writes go through
 * a linked session as omp's own command or a prompt.
 */
export function Lab({ view }: { view: LabView }) {
  const t = useT();
  // The registry snapshot is the one input; projects derive from it on
  // every state tick, which is what keeps a newly registered project in scope.
  const state = useStore((s) => s.state);
  const openLab = useStore((s) => s.openLab);
  const closeLab = useStore((s) => s.closeLab);
  const openExperimentDialog = useStore((s) => s.openExperimentDialog);
  const loadExperiments = useStore((s) => s.loadExperiments);
  const loadExperimentDetail = useStore((s) => s.loadExperimentDetail);

  const all: readonly ScopedProject[] =
    state === null
      ? EMPTY_SCOPE
      : [
          ...state.projects.map((group) => ({
            key: projectKey(null, group.project.path),
            instanceId: null,
            label: group.project.name,
            group,
          })),
          ...state.remoteInstances.flatMap((instance) =>
            instance.projects.map((group) => ({
              key: projectKey(instance.id, group.project.path),
              instanceId: instance.id,
              label: `${instance.nickname} · ${group.project.name}`,
              group,
            })),
          ),
        ];
  const scopeKey = view.projectCwd === null ? "" : projectKey(view.instanceId, view.projectCwd);
  const scoped = scopeKey === "" ? all : all.filter((p) => p.key === scopeKey);
  const scopedKeys = scoped.map((p) => p.key).join("\n");

  useEffect(() => {
    for (const p of scoped) void loadExperiments(p.group.project.path, p.instanceId);
    // `scopedKeys` stands in for the list: the effect re-runs when a project
    // enters or leaves the scope, not on every registry broadcast.
  }, [scopedKeys, loadExperiments]);

  const refresh = (): void => {
    for (const p of scoped) void loadExperiments(p.group.project.path, p.instanceId);
    if (view.experiment !== null) void loadExperimentDetail(view.experiment);
  };

  return (
    <div className="absolute inset-0 overflow-auto bg-void text-ink">
      <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line chrome-void px-3">
        <Label>{t("lab.header.title")}</Label>
        {view.experiment !== null && (
          <Button variant="ghost" size="xs" onClick={() => openLab(view.projectCwd, view.instanceId)}>
            ← {t("lab.detail.back")}
          </Button>
        )}
        <select
          aria-label={t("lab.header.scope")}
          value={scopeKey}
          onChange={(event) => {
            const picked = all.find((p) => p.key === event.target.value);
            if (picked === undefined) openLab(null, null);
            else openLab(picked.group.project.path, picked.instanceId);
          }}
          className="h-6 max-w-[16rem] rounded-md border border-line bg-raised px-1.5 text-[11px] text-ink-mid"
        >
          <option value="">{t("lab.header.allProjects")}</option>
          {all.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <IconButton label={t("lab.header.refresh")} onClick={refresh}>
          <IconRefresh />
        </IconButton>
        <Button
          tone="iris"
          variant="solid"
          size="xs"
          disabled={view.projectCwd === null}
          title={view.projectCwd === null ? t("lab.header.newExperimentScopeHint") : undefined}
          onClick={() => {
            if (view.projectCwd !== null) openExperimentDialog(view.projectCwd, view.instanceId);
          }}
        >
          {t("lab.header.newExperiment")}
        </Button>
        <IconButton label={t("lab.header.close")} onClick={closeLab}>
          <IconClose className="size-3.5" />
        </IconButton>
      </header>
      {view.experiment !== null ? (
        <ExperimentDetail target={view.experiment} />
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-4">
          {scoped.map((p) => (
            <ProjectExperimentsSection key={p.key} project={p} />
          ))}
          {scoped.length === 0 && <p className="py-10 text-center text-xs text-ink-faint">{t("lab.overview.empty")}</p>}
        </div>
      )}
    </div>
  );
}

function ProjectExperimentsSection({ project }: { project: ScopedProject }) {
  const t = useT();
  const { group, instanceId, key } = project;
  const cache = useStore((s) => s.experiments[key]);
  const rpc = useStore((s) => s.rpc);
  const openLabExperiment = useStore((s) => s.openLabExperiment);
  const checkouts = cache?.result?.checkouts ?? [];
  const pendingLaunches = cache?.result?.pendingLaunches ?? [];
  // A host from before the Lab has no `autoresearch:*` channels at all; its
  // dispatcher rejects by name, and that is the one error worth translating.
  const unsupported = cache?.error?.includes("unknown channel") === true;
  const total = checkouts.reduce((n, c) => n + c.result.experiments.length, 0) + pendingLaunches.length;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-sm font-semibold">{project.label}</h2>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">{group.project.path}</span>
        {cache?.load === "loading" && <span className="text-[10px] text-ink-faint">{t("lab.overview.loading")}</span>}
      </div>
      {unsupported && <p className="text-xs text-ink-faint">{t("lab.overview.unsupportedHost")}</p>}
      {!unsupported && cache?.error !== null && cache?.error !== undefined && (
        <p className="text-xs text-rose">{cache.error}</p>
      )}
      {checkouts.map(
        (checkout) =>
          checkout.result.error !== null && (
            <p key={checkout.cwd} className="truncate text-xs text-rose" title={checkout.result.error}>
              {t("lab.overview.checkoutError", { cwd: checkout.cwd, error: checkout.result.error })}
            </p>
          ),
      )}
      {total > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {checkouts.flatMap((checkout) =>
            checkout.result.experiments.map((record) => {
              const session = experimentSession(checkout.tabId, record, group.sessions);
              return (
                <ExperimentCard
                  key={`${checkout.tabId ?? ""}:${record.id}`}
                  record={record}
                  state={experimentState(
                    record,
                    session,
                    session === null ? null : (rpc[session.tabId]?.autoresearch ?? null),
                  )}
                  dbPath={checkout.result.source?.dbPath}
                  onOpen={() =>
                    openLabExperiment({
                      projectCwd: group.project.path,
                      instanceId,
                      tabId: checkout.tabId,
                      experimentId: record.id,
                    })
                  }
                />
              );
            }),
          )}
          {pendingLaunches.map((launch) => (
            <PendingExperimentCard
              key={launch.tabId}
              experiment={launch.experiment}
              title={group.sessions.find((s) => s.tabId === launch.tabId)?.title ?? launch.experiment.goal}
            />
          ))}
        </div>
      )}
      {cache?.result != null && total === 0 && !unsupported && (
        <p className="text-xs text-ink-faint">{t("lab.overview.empty")}</p>
      )}
    </section>
  );
}
