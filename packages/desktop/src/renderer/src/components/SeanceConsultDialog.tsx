import { useMemo, useState } from "react";
import type { LiveState, SessionSummary } from "@omp-ui/core/types";
import { backendFor } from "../backend";
import type { MessageKey } from "../lib/i18n";
import { useT } from "../lib/i18n";
import { relativeTime } from "../lib/format";
import { projectKey } from "../lib/project-key";
import { SEANCE_MIN_OMP, supportsSeance } from "../lib/seance";
import type { ModelInfo } from "../lib/rpc-types";
import { findInstance, resolveSeanceSource, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Button, ConfirmDialog } from "./ui";

const FIELD =
  "mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";
const LABEL = "block text-[10px] text-ink-faint";

/** Stable empty list so the palette does not resubscribe on every store tick. */
const EMPTY_MODELS: ModelInfo[] = [];

/** The sidebar's live-state words, reused verbatim on each source row. */
const LIVE_LABEL: Record<LiveState, MessageKey> = {
  live: "sidebar.status.liveLabel",
  dormant: "sidebar.status.dormantLabel",
  archived: "sidebar.status.archivedLabel",
  missing: "sidebar.status.missingLabel",
};

/** One project (local or on a joined instance) with its consultable sessions. */
interface SourceGroup {
  key: string;
  name: string;
  path: string;
  rows: SessionSummary[];
}

/**
 * The Seance consult dialog (issue #885, CONTEXT.md "Seance consult"): pick a
 * saved session — never resumed, never modified — ask one question of it, and
 * optionally override the consultant's model. App mounts it while
 * `seanceDialog` is non-null: with `sourceTabId` the consulting runs in place
 * on the invoking live tab; without it, submitting spawns a fresh consult
 * session in the source's project. The source token resolves through
 * `resolveSeanceSource`; anything unresolvable rides verbatim so omp's own
 * error sentence speaks. Below the omp version floor the form renders disabled
 * with the required version as its title (the disabled-in-place convention).
 */
export function SeanceConsultDialog() {
  const t = useT();
  const init = useStore((s) => s.seanceDialog);
  const projectCwd = init?.projectCwd ?? "";
  const instanceId = init?.instanceId ?? null;
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);
  const enabled = useStore((s) => supportsSeance(s.ompUpdate.installedVersion));
  const closeSeanceDialog = useStore((s) => s.closeSeanceDialog);
  const launchSeanceConsult = useStore((s) => s.launchSeanceConsult);

  const [query, setQuery] = useState(init?.prefill?.source ?? "");
  const [chosen, setChosen] = useState<SessionSummary | null>(null);
  // null = omp's saved-model default stands; a picked selector overrides the
  // consultant's model inside the task call, not this session's.
  const [modelOverride, setModelOverride] = useState<string | null>(init?.prefill?.model ?? null);
  const [question, setQuestion] = useState("");
  const [pickingModel, setPickingModel] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gateTitle = enabled ? undefined : t("rail.seance.needsNewerOmp", { version: SEANCE_MIN_OMP });

  // Every registry session with a saved transcript (sessionId materialized),
  // grouped by project — this app's own projects first, then joined remote
  // instances' (the store.ts reconcile enumeration). Non-live rows lead: the
  // consult targets saved history, a live session is the odd case.
  const groups = useMemo<SourceGroup[]>(() => {
    if (state === null) return [];
    const owners: SourceGroup[] = [];
    for (const group of state.projects) {
      owners.push({
        key: projectKey(null, group.project.path),
        name: group.project.name,
        path: group.project.path,
        rows: group.sessions,
      });
    }
    owners.push({ key: "chats", name: t("seance.dialog.chatsGroup"), path: "", rows: state.chats });
    for (const instance of state.remoteInstances) {
      if (instance.status !== "joined") continue;
      for (const group of instance.projects) {
        owners.push({
          key: projectKey(instance.id, group.project.path),
          name: group.project.name,
          path: group.project.path,
          rows: group.sessions,
        });
      }
    }
    const needle = query.trim().toLowerCase();
    return owners
      .map((group) => {
        const owned = group.rows.filter(
          (session) =>
            session.sessionId !== null &&
            (needle === "" ||
              session.title.toLowerCase().includes(needle) ||
              session.sessionId!.startsWith(needle)),
        );
        return {
          ...group,
          rows: [...owned.filter((s) => s.live !== "live"), ...owned.filter((s) => s.live === "live")],
        };
      })
      .filter((group) => group.rows.length > 0);
  }, [state, query, t]);

  // The init's project group feeds the model catalog: a live session's
  // availableModels is all the model list that exists (the NewExperimentDialog
  // / ProjectSettings idiom); the first non-empty one wins.
  const modelGroup = useMemo(() => {
    const candidates = instanceId === null ? state?.projects : findInstance(state, instanceId)?.projects;
    return candidates?.find((g) => g.project.path === projectCwd) ?? null;
  }, [state, instanceId, projectCwd]);
  const models = useMemo(() => {
    for (const session of modelGroup?.sessions ?? []) {
      if (session.live !== "live") continue;
      const list = rpc[session.tabId]?.availableModels;
      if (list !== undefined && list.length > 0) return list;
    }
    return EMPTY_MODELS;
  }, [modelGroup, rpc]);
  const currentModel = useMemo(
    () =>
      modelOverride === null
        ? null
        : (models.find((m) => `${m.provider}/${m.id}` === modelOverride) ?? null),
    [modelOverride, models],
  );

  const sourceMissing = chosen === null && query.trim() === "";
  const questionMissing = question.trim() === "";
  const canSubmit = enabled && !pending && !sourceMissing && !questionMissing;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      // A picked row resolves by its session id (the resolver upgrades owned
      // matches to transcript paths); typed text resolves as a token.
      const token = chosen?.sessionId ?? query.trim();
      let resolved = await resolveSeanceSource(state, instanceId, token);
      if (resolved === null) {
        resolved =
          chosen !== null
            ? {
                // A picked row always has its own record to fall back on.
                sourceSession:
                  (await backendFor(instanceId).sessionTranscriptPath(chosen.tabId)) ?? chosen.sessionId!,
                sourceLabel: chosen.title,
                private: chosen.private,
              }
            : // Junk or ambiguous token: forward it verbatim — omp's own error speaks.
              { sourceSession: token, sourceLabel: token, private: false };
      }
      const target = {
        projectCwd,
        instanceId,
        ...(init?.sourceTabId === undefined ? {} : { tabId: init.sourceTabId }),
        ...resolved,
      };
      await launchSeanceConsult(target, question.trim(), modelOverride);
      closeSeanceDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  if (init === null) return null;
  return (
    <ConfirmDialog
      kicker={t("rail.tabs.seance")}
      title={t("seance.dialog.title")}
      tone="iris"
      onClose={closeSeanceDialog}
      width="w-[30rem]"
      actions={
        <>
          <Button variant="ghost" onClick={closeSeanceDialog}>
            {t("seance.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone="iris"
            disabled={!canSubmit}
            title={gateTitle}
            onClick={() => void submit()}
          >
            {t("seance.dialog.launch")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="seance-source" className={LABEL}>
            {t("seance.dialog.source")}
          </label>
          <input
            id="seance-source"
            value={query}
            spellCheck={false}
            disabled={!enabled}
            title={gateTitle}
            placeholder={t("sidebar.filter.placeholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              // Editing past the picked row's title means a typed token now.
              if (chosen !== null && event.target.value !== chosen.title) setChosen(null);
            }}
            className={FIELD}
            data-modal-initial-focus
          />
          <div className="mt-1.5 max-h-44 overflow-y-auto rounded-md border border-line bg-void">
            {groups.length === 0 ? (
              <p className="px-2 py-2 text-[10px] text-ink-faint">{t("transcript.findbar.noMatches")}</p>
            ) : (
              groups.map((group) => (
                <div key={group.key}>
                  <p className="sticky top-0 truncate bg-raised px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
                    {group.name} <span className="normal-case tracking-normal">{group.path}</span>
                  </p>
                  {group.rows.map((session) => (
                    <button
                      key={session.tabId}
                      type="button"
                      disabled={!enabled}
                      onClick={() => {
                        setChosen(session);
                        setQuery(session.title);
                      }}
                      className={`flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-hover disabled:cursor-default ${
                        chosen?.tabId === session.tabId ? "bg-hover" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">{session.title}</span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        {relativeTime(session.cachedModified)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        {t(LIVE_LABEL[session.live])}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <span className={LABEL}>{t("seance.dialog.modelLabel")}</span>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              disabled={!enabled || models.length === 0}
              title={gateTitle ?? (modelOverride ?? t("seance.dialog.modelSaved"))}
              onClick={() => setPickingModel(true)}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-line bg-void px-2 py-1.5 text-left font-mono text-[11px] text-ink hover:border-line-strong disabled:cursor-default disabled:text-ink-faint"
            >
              <span className="truncate">{modelOverride ?? t("seance.dialog.modelSaved")}</span>
            </button>
            {modelOverride !== null && (
              <Button
                variant="ghost"
                disabled={!enabled}
                title={gateTitle ?? t("composer.model.clear")}
                onClick={() => setModelOverride(null)}
              >
                {t("composer.model.clear")}
              </Button>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="seance-question" className={LABEL}>
            {t("seance.dialog.question")}
          </label>
          <textarea
            id="seance-question"
            rows={3}
            value={question}
            spellCheck={false}
            disabled={!enabled}
            title={gateTitle}
            onChange={(event) => setQuestion(event.target.value)}
            className={`${FIELD} resize-none`}
          />
        </div>

        {error !== null && <p className="text-xs leading-relaxed text-rose">{error}</p>}
      </div>

      {pickingModel && (
        <ModelPalette
          variant="main"
          models={models}
          current={currentModel}
          instanceId={instanceId}
          onClose={() => setPickingModel(false)}
          onPick={(picked) => {
            setPickingModel(false);
            setModelOverride(`${picked.provider}/${picked.id}`);
          }}
        />
      )}
    </ConfirmDialog>
  );
}
