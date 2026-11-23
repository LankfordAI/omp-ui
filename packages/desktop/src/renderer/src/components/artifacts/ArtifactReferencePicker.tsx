import { useId, useMemo, useState } from "react";
import type { ArtifactDescription } from "@omp-ui/core/artifacts";
import type { SessionSummary } from "@omp-ui/core/types";
import { backend, displayMessage } from "../../backend";
import { relativeTime } from "../../lib/format";
import { useStore } from "../../store";
import { Button, Chip, IconButton, IconClose, Modal, Switch } from "../ui";
import { getNavigationGeneration } from "../../store/slices/view";

type PickerTarget =
  | { kind: "run" }
  | { kind: "new-project"; projectCwd: string; projectName: string }
  | { kind: "new-chat" }
  | { kind: "session"; tabId: string };

function targetKey(target: PickerTarget | null): string {
  if (!target) return "";
  if (target.kind === "run") return "run";
  if (target.kind === "new-chat") return "new:chat";
  if (target.kind === "new-project") return `new:project:${target.projectCwd}`;
  return `session:${target.tabId}`;
}

function isSettled(session: SessionSummary): boolean {
  return session.settledAtMs !== null || session.live === "archived";
}

export function ArtifactReferencePicker({
  description,
  mode = "reference",
  onClose,
  onRefreshStarted,
}: {
  description: ArtifactDescription;
  mode?: "reference" | "refresh";
  onClose(): void;
  onRefreshStarted?(): void;
}) {
  const titleId = useId();
  const state = useStore((s) => s.state);
  const origin = description.artifact.originContext;
  const originProject = origin.kind === "project"
    ? (state?.projects.find((group) => group.project.path === origin.path) ?? null)
    : null;

  const [target, setTarget] = useState<PickerTarget | null>(() => {
    if (mode === "refresh") return { kind: "run" };
    if (originProject) return { kind: "new-project", projectCwd: originProject.project.path, projectName: originProject.project.name };
    return { kind: "new-chat" };
  });
  const [search, setSearch] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const [includeData, setIncludeData] = useState(false);
  const [datasetIds, setDatasetIds] = useState<string[]>(() =>
    mode === "refresh" ? description.snapshot.datasets.map((dataset) => dataset.id) : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needle = search.trim().toLowerCase();
  const grouped = useMemo(() => {
    const matches = (session: SessionSummary, groupLabel: string): boolean => {
      if (!needle) return true;
      return (session.title || session.tabId).toLowerCase().includes(needle) || groupLabel.toLowerCase().includes(needle);
    };
    const projectGroups: Array<{ key: string; label: string; sessions: SessionSummary[] }> = [];
    const settled: Array<{ session: SessionSummary; groupLabel: string }> = [];
    for (const group of state?.projects ?? []) {
      const eligible = group.sessions.filter((s) => s.mode === "rpc-ui" && s.live !== "missing" && matches(s, group.project.name));
      const active = eligible.filter((s) => !isSettled(s));
      for (const s of eligible) if (isSettled(s)) settled.push({ session: s, groupLabel: group.project.name });
      if (active.length > 0) projectGroups.push({ key: group.project.path, label: group.project.name, sessions: active });
    }
    const chatEligible = (state?.chats ?? []).filter((s) => s.mode === "rpc-ui" && s.live !== "missing" && matches(s, "Chat"));
    const activeChats = chatEligible.filter((s) => !isSettled(s));
    for (const s of chatEligible) if (isSettled(s)) settled.push({ session: s, groupLabel: "Chat" });
    return { projectGroups, activeChats, settled };
  }, [state, needle]);

  const runNow = mode === "refresh" && target?.kind === "run";
  const submit = async (): Promise<void> => {
    if (!target) return;
    setBusy(true); setError(null);
    const navigationGeneration = getNavigationGeneration();
    try {
      const store = useStore.getState();
      if (target.kind === "run") {
        const started = await store.runArtifactRefresh({
          artifactId: description.artifact.artifactId,
          codeRevisionId: description.code.codeRevisionId,
          dataSnapshotId: description.snapshot.dataSnapshotId,
          datasetIds,
          title: description.artifact.title,
          projectCwd: originProject?.project.path ?? null,
        });
        if (started === null) throw new Error("The refresh session could not start.");
        onRefreshStarted?.();
        onClose();
        return;
      }
      if (target.kind === "new-project" || target.kind === "new-chat") {
        const started = await store.referenceArtifactInNewSession({
          artifactId: description.artifact.artifactId,
          codeRevisionId: description.code.codeRevisionId,
          dataSnapshotId: description.snapshot.dataSnapshotId,
          includeData,
          projectCwd: target.kind === "new-project" ? target.projectCwd : null,
          navigationGeneration,
        });
        if (started === null) throw new Error("The new session could not start.");
        onClose();
        return;
      }
      const tabId = target.tabId;
      const exact = {
        targetTabId: tabId,
        artifactId: description.artifact.artifactId,
        codeRevisionId: description.code.codeRevisionId,
        dataSnapshotId: description.snapshot.dataSnapshotId,
      };
      if (mode === "refresh") {
        const prepared = await backend.artifactPrepareRefresh({ ...exact, datasetIds });
        const entry = {
          version: 1 as const,
          refreshRequestId: prepared.request.refreshRequestId,
          artifactId: prepared.request.artifactId,
          title: prepared.reference.title,
          datasetIds: prepared.request.datasetIds,
        };
        if (!await store.attachArtifactRefreshDraft(tabId, prepared.reference, entry, { navigationGeneration })) return;
      } else {
        const reference = await backend.artifactReference({ ...exact, includeData });
        if (!await store.referenceArtifactInSession(tabId, reference, { navigationGeneration })) return;
      }
      onClose();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectedKey = targetKey(target);
  const renderOption = (option: PickerTarget, label: string, meta?: string, badge?: string) => {
    const key = targetKey(option);
    const selected = selectedKey === key;
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={selected}
        disabled={busy}
        onClick={() => setTarget(option)}
        className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
          selected
            ? "border-copper bg-copper-wash/40 text-ink"
            : "border-transparent bg-raised/60 text-ink-mid hover:border-line hover:bg-hover hover:text-ink"
        }`}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-ink-faint">
          {badge && <Chip tone={badge === "live" ? "signal" : "neutral"}>{badge}</Chip>}
          {meta && <span>{meta}</span>}
        </span>
      </button>
    );
  };

  const settledVisible = showSettled || needle.length > 0;

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} labelledBy={titleId} width="w-[min(36rem,96vw)]" className="flex max-h-[90dvh] flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">{mode === "refresh" ? "Refresh data" : "Reference in session"}</h2>
        <IconButton label="close dialog" onClick={onClose} disabled={busy}><IconClose /></IconButton>
      </header>
      <div className="min-h-0 space-y-4 overflow-y-auto p-4">
        <p className="break-words text-sm text-ink-mid">{description.artifact.title}</p>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-mid">{mode === "refresh" ? "Run refresh in" : "Session on this machine"}</span>
            <input
              autoFocus
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter sessions…"
              aria-label="Filter sessions"
              disabled={busy}
              className="w-52 max-w-full rounded border border-line bg-raised px-2 py-1 text-xs text-ink outline-none focus-visible:border-copper"
            />
          </div>
          <div role="listbox" aria-label={mode === "refresh" ? "Run refresh in" : "Session on this machine"} className="max-h-56 space-y-2.5 overflow-y-auto rounded-md border border-line bg-sunken/40 p-2">
            <div className="space-y-1">
              <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Start fresh</div>
              {mode === "refresh" ? (
                renderOption(
                  { kind: "run" },
                  originProject ? `A new background session in ${originProject.project.name}` : "A new background Chat",
                  "Runs now",
                )
              ) : (
                <>
                  {originProject && renderOption(
                    { kind: "new-project", projectCwd: originProject.project.path, projectName: originProject.project.name },
                    `New session in ${originProject.project.name}`,
                    "Draft chip",
                  )}
                  {renderOption({ kind: "new-chat" }, "New Chat", "Draft chip")}
                </>
              )}
            </div>
            {grouped.projectGroups.map((group) => (
              <div key={group.key} className="space-y-1">
                <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">{group.label}</div>
                {group.sessions.map((session) => {
                  const stamp = session.cachedModified ?? session.launchedAt;
                  return renderOption(
                    { kind: "session", tabId: session.tabId },
                    session.title || session.tabId,
                    stamp ? relativeTime(stamp) : undefined,
                    session.live === "live" ? "live" : "dormant",
                  );
                })}
              </div>
            ))}
            {grouped.activeChats.length > 0 && (
              <div className="space-y-1">
                <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Chats</div>
                {grouped.activeChats.map((session) => {
                  const stamp = session.cachedModified ?? session.launchedAt;
                  return renderOption(
                    { kind: "session", tabId: session.tabId },
                    session.title || session.tabId,
                    stamp ? relativeTime(stamp) : undefined,
                    session.live === "live" ? "live" : "dormant",
                  );
                })}
              </div>
            )}
            {grouped.settled.length > 0 && (
              <div className="space-y-1 border-t border-line-soft pt-1.5">
                <button
                  type="button"
                  onClick={() => setShowSettled((open) => !open)}
                  className="flex w-full items-center justify-between px-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint hover:text-ink-mid"
                >
                  <span>{`Settled (${grouped.settled.length})`}</span>
                  <span>{settledVisible ? "▾" : "▸"}</span>
                </button>
                {settledVisible && grouped.settled.map(({ session, groupLabel }) =>
                  renderOption(
                    { kind: "session", tabId: session.tabId },
                    session.title || session.tabId,
                    groupLabel,
                    "settled",
                  ),
                )}
              </div>
            )}
          </div>
        </div>
        {mode === "reference" ? (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>Include saved data</span>
              <Switch on={includeData} onChange={setIncludeData} label="Include saved data" />
            </div>
            <p className="text-xs leading-relaxed text-ink-dim">
              Off shares the definition only. HTML itself can contain sensitive information or bundled data. With consent, this exact saved data snapshot is also readable by the session.
            </p>
          </>
        ) : (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-semibold">Datasets to refresh</legend>
              {description.snapshot.datasets.map((dataset) => (
                <label key={dataset.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={datasetIds.includes(dataset.id)}
                    onChange={(event) =>
                      setDatasetIds((old) =>
                        event.target.checked ? [...old, dataset.id] : old.filter((id) => id !== dataset.id),
                      )
                    }
                  />
                  <span className="min-w-0 break-words">
                    <strong className="block font-medium">{dataset.title}</strong>
                    <span className="text-xs text-ink-dim">{dataset.provenance.source.label}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-ink-dim">
              {runNow
                ? "Starts a new session in the background and sends the refresh request now. Project sessions start in Plan mode; Chats run in Build mode. Captured data waits under Data until you choose Apply."
                : "Adds a removable reference and a removable refresh request to that session's draft. Nothing is sent until you send it."}
            </p>
          </>
        )}
        {error && <p role="alert" className="text-sm text-rose">{error}</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line p-3">
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="solid" disabled={busy || !target || (mode === "refresh" && datasetIds.length === 0)} onClick={() => void submit()}>
          {busy ? "Loading…" : runNow ? "Refresh now" : "Add to draft"}
        </Button>
      </footer>
    </Modal>
  );
}
