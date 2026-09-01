import { useEffect, useRef, useState } from "react";
import type {
  MemoryOverview,
  OmpSettingEntry,
  OmpSettingValue,
} from "@omp-ui/core/types";
import { MEMORY_SETTING_GROUP } from "@omp-ui/core/omp-settings-keys";
import { backend, displayMessage } from "../../backend";
import { useStore } from "../../store";
import { Button, Chip, Empty, Label, Panel } from "../ui";
import { Row, SettingControl, layerBadge } from "./rows";
import { useT } from "../../lib/i18n";
import { OMP_MISSING, type FooterContext, type Load } from "./types";

type OverviewLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; overview: MemoryOverview }
  | { status: "error"; message: string };

function MemoryBankPath({
  label,
  path,
  exists,
}: {
  label: string;
  path: string;
  exists: boolean;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <span className="truncate font-mono text-[10px] text-ink-mid" title={path}>
        {path}
      </span>
      <Chip tone={exists ? undefined : "copper"}>
        {exists ? t("settings.memory.exists") : t("settings.memory.notCreated")}
      </Chip>
    </div>
  );
}

function MemoryOverviewPanel({
  load,
  projectCwd,
  retry,
}: {
  load: OverviewLoad;
  projectCwd: string | null;
  retry: () => void;
}) {
  const t = useT();
  if (projectCwd === null) {
    return (
      <Panel className="px-3 py-2.5">
        <Label>{t("settings.memory.resolvedMemory")}</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {t("settings.memory.focusTab")}
        </p>
      </Panel>
    );
  }
  if (load.status === "idle" || load.status === "loading") {
    return (
      <Panel className="px-3 py-2.5">
        <Label>{t("settings.memory.resolvedMemory")}</Label>
        <p className="mt-1 text-[11px] text-ink-faint">{t("settings.memory.discovering")}</p>
      </Panel>
    );
  }
  if (load.status === "error") {
    return (
      <Panel className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-rose">{load.message}</p>
          <Button size="xs" onClick={retry}>{t("settings.memory.retry")}</Button>
        </div>
      </Panel>
    );
  }

  const { overview } = load;
  return (
    <Panel className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label className="mr-auto">{t("settings.memory.resolvedMemory")}</Label>
        <Chip mono>{overview.backend}</Chip>
        <Chip mono>{overview.scoping}</Chip>
      </div>
      {overview.error !== null && (
        <div className="flex items-center justify-between gap-3 rounded border border-rose-dim/50 bg-rose-wash px-2 py-1.5">
          <p className="text-[11px] leading-relaxed text-rose">{overview.error}</p>
          <Button size="xs" onClick={retry}>{t("settings.memory.retry")}</Button>
        </div>
      )}
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wide text-ink-faint">{t("settings.memory.base")}</span>
        <span className="truncate font-mono text-[10px] text-ink-mid" title={overview.baseDir}>
          {overview.baseDir}
        </span>
      </div>
      <MemoryBankPath
        label="global"
        path={overview.global.dbPath}
        exists={overview.global.exists}
      />
      {overview.project !== null ? (
        <MemoryBankPath
          label="project"
          path={overview.project.dbPath}
          exists={overview.project.exists}
        />
      ) : (
        <p className="text-[10px] leading-relaxed text-ink-faint">
          {overview.scoping === "global"
            ? t("settings.memory.globalBank")
            : t("settings.memory.noProjectBank")}
        </p>
      )}
    </Panel>
  );
}

export function MemoryPage({
  load,
  projectCwd,
  pendingKey,
  writeError,
  commit,
  retry,
  overviewRevision,
}: {
  load: Load;
  projectCwd: string | null;
  pendingKey: string | null;
  writeError: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
  overviewRevision: number;
}) {
  const t = useT();
  const openSettings = useStore((state) => state.openSettings);
  const [overviewLoad, setOverviewLoad] = useState<OverviewLoad>({ status: "idle" });
  const [overviewRetry, setOverviewRetry] = useState(0);
  const overviewGeneration = useRef(0);

  useEffect(() => {
    const generation = ++overviewGeneration.current;
    if (projectCwd === null) {
      setOverviewLoad({ status: "idle" });
      return;
    }

    let stale = false;
    setOverviewLoad({ status: "loading" });
    backend.memoryOverview(projectCwd).then(
      (overview) => {
        if (!stale && generation === overviewGeneration.current) {
          setOverviewLoad({ status: "loaded", overview });
        }
      },
      (error: unknown) => {
        if (!stale && generation === overviewGeneration.current) {
          setOverviewLoad({ status: "error", message: displayMessage(error) });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [projectCwd, overviewRevision, overviewRetry]);

  const overviewPanel = (
    <MemoryOverviewPanel
      load={overviewLoad}
      projectCwd={projectCwd}
      retry={() => setOverviewRetry((revision) => revision + 1)}
    />
  );

  if (load.status === "loading") {
    return (
      <div className="space-y-3 px-4 py-3">
        {overviewPanel}
        <Empty title={t("settings.memory.reading")} />
      </div>
    );
  }
  const failure =
    load.status === "error"
      ? load.message
      : load.snapshot.error !== null
        ? load.snapshot.error
        : null;
  if (failure !== null || load.status !== "loaded") {
    const missing = failure === OMP_MISSING;
    return (
      <div className="space-y-3 px-4 py-3">
        {overviewPanel}
        <Empty
          title={t("settings.memory.readFailed")}
          hint={missing ? t("settings.memory.ompMissingHint") : (failure ?? undefined)}
          action={
            <div className="flex items-center gap-2">
              <Button size="xs" onClick={retry}>{t("settings.memory.retry")}</Button>
              {missing && (
                <Button size="xs" variant="ghost" onClick={() => openSettings("updates")}>
                  {t("settings.memory.installFromUpdates")}
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }

  const byKey = new Map(load.snapshot.entries.map((entry) => [entry.key, entry]));
  const entries = MEMORY_SETTING_GROUP.keys
    .map((key) => byKey.get(key))
    .filter((entry): entry is OmpSettingEntry => entry !== undefined);

  return (
    <div className="space-y-3 px-4 py-3">
      <div>
        <p className="text-xs font-medium text-ink">{t("settings.memory.title")}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          {t("settings.memory.titleHint")}
        </p>
      </div>
      {overviewPanel}
      {writeError !== null && (
        <p className="rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {writeError}
        </p>
      )}
      {entries.length > 0 && (
        <section>
          <div className="flex items-center gap-2">
            <Label>{MEMORY_SETTING_GROUP.title}</Label>
          </div>
          {MEMORY_SETTING_GROUP.description !== undefined && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
              {MEMORY_SETTING_GROUP.description}
            </p>
          )}
          <div className="mt-1 divide-y divide-line-soft">
            {entries.map((entry) => (
              <Row
                key={entry.key}
                title={entry.key}
                hint={entry.description}
                badge={layerBadge(entry.layer)}
              >
                <SettingControl entry={entry} pendingKey={pendingKey} commit={commit} />
              </Row>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function MemoryFooter({ agentDir }: FooterContext) {
  const t = useT();
  return (
    <p>
      {t("settings.memory.footerIntro")}
      <span className="font-mono">{agentDir ?? "…"}/config.yml</span>
      {t("settings.memory.footerProjectPrefix")}
      <span className="font-mono">.omp/config.yml</span>
      {t("settings.memory.footerCanWin")}
      <span className="font-mono">project</span>
      {t("settings.memory.footerEnd")}
    </p>
  );
}
