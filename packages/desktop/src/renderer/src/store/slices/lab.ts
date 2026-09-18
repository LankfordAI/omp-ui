// Experiments Lab domain (issue #559, ADR-0030): the Lab surface's view
// state, the per-project cache of omp's autoresearch DB projections, and the
// New experiment launch — a worktree rpc-ui session armed with bare
// `/autoresearch` and seeded with one kickoff prompt. omp-ui never writes the
// DB and never re-implements the loop; every mutation here rides omp's own
// slash command or a prompt.
import type { SessionMode } from "@omp-ui/core/types";
import { experimentLaunchedValue, type ExperimentProposal } from "@omp-ui/core/autoresearch";
import { backend, backendFor } from "../../backend";
import { strField } from "../../lib/fields";
import {
  experimentInterviewPrompt,
  experimentKickoff,
  experimentSlug,
  NEW_SEGMENT_PROMPT,
} from "../../lib/experiment-kickoff";
import { linkedExperiment } from "../../lib/experiment-link";
import { t } from "../../lib/i18n";
import { projectKey, splitProjectKey } from "../../lib/project-key";
import { dropExited, type GetState, type SetState, type StoreMachinery } from "./shared";
import { findRecord, focusOn } from "./view";
import type { ExperimentsCache, LabSlice, LabView, NewExperimentSpec } from "../types";

export interface LabDeps {
  resolveSpawnParams(
    projectCwd: string,
    overrides?: { mode?: SessionMode; advisor?: boolean; advisorModel?: string | null },
    instanceId?: string | null,
  ): Promise<{ mode: SessionMode; advisor: boolean; advisorModel: string | null }>;
}

/** How often an open Lab re-reads the DBs it shows; omp writes them between turns. */
export const LAB_REFRESH_MS = 30_000;

/**
 * Per-key request generations (the `nextEnsureGeneration` idiom): a reply
 * lands only while it is still the newest ask for its key, so a slow overview
 * can never overwrite a fresher one. Module-level so they survive a store
 * reset the way the DBs they guard do.
 */
const overviewGeneration = new Map<string, number>();
const detailGeneration = new Map<string, number>();

/** The one refresh interval; null while the Lab is closed. */
let refreshTimer: number | null = null;

export function createLabSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: LabDeps,
): LabSlice {
  /** The ten proposal fields of a submitted spec, as launched. */
  const proposalOf = (spec: NewExperimentSpec): ExperimentProposal => ({
    goal: spec.goal,
    metric: spec.metric,
    unit: spec.unit,
    direction: spec.direction,
    command: spec.command,
    scopePaths: spec.scopePaths,
    offLimits: spec.offLimits,
    constraints: spec.constraints,
    maxIterations: spec.maxIterations,
    brief: spec.brief,
  });

  /** The first tab still holding a proposal, or null. Tab order = arrival order in `tabs`. */
  const nextProposalTab = (): { tabId: string; projectCwd: string; instanceId: string | null } | null => {
    for (const tab of get().tabs) {
      if (get().rpc[tab.tabId]?.experimentProposal) return tab;
    }
    return null;
  };

  const openNextProposal = (): void => {
    if (get().experimentDialog !== null) return;
    const next = nextProposalTab();
    if (next !== null)
      set({ experimentDialog: { projectCwd: next.projectCwd, instanceId: next.instanceId, proposalTabId: next.tabId } });
  };

  const acceptExperimentProposal: LabSlice["acceptExperimentProposal"] = (tabId, proposal, frame) => {
    const held = get().rpc[tabId]?.experimentProposal;
    if (held && strField(held.frame, "id") === strField(frame, "id")) return; // same frame, replayed
    m.patchRpc(tabId, { experimentProposal: { proposal, frame } });
    openNextProposal();
  };

  const answerExperimentProposal: LabSlice["answerExperimentProposal"] = (tabId, value) => {
    const held = get().rpc[tabId]?.experimentProposal;
    if (!held) return false;
    // The agent is blocked on this reply — clear only after sending. An exited
    // process has nothing to release; the form was still worth keeping.
    if (get().exited[tabId] === undefined)
      backend.rpcSend(tabId, {
        type: "extension_ui_response",
        id: strField(held.frame, "id"),
        value,
      });
    m.patchRpc(tabId, { experimentProposal: null });
    return true;
  };

  const patchCache = (key: string, patch: (prev: ExperimentsCache) => Partial<ExperimentsCache>): void => {
    set((s) => {
      const prev: ExperimentsCache = s.experiments[key] ?? {
        load: "idle",
        result: null,
        detail: {},
        error: null,
        revision: 0,
      };
      return { experiments: { ...s.experiments, [key]: { ...prev, ...patch(prev) } } };
    });
  };

  const loadExperiments = async (projectCwd: string, instanceId: string | null = null): Promise<void> => {
    const key = projectKey(instanceId, projectCwd);
    const generation = (overviewGeneration.get(key) ?? 0) + 1;
    overviewGeneration.set(key, generation);
    patchCache(key, () => ({ load: "loading" }));
    try {
      const result = await backendFor(instanceId).autoresearchOverview(projectCwd);
      if (overviewGeneration.get(key) !== generation) return;
      patchCache(key, (prev) => ({ load: "ready", result, error: null, revision: prev.revision + 1 }));
    } catch (err) {
      if (overviewGeneration.get(key) !== generation) return;
      patchCache(key, () => ({ load: "error", error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const loadExperimentDetail = async (target: NonNullable<LabView["experiment"]>): Promise<void> => {
    const key = projectKey(target.instanceId, target.projectCwd);
    const detailKey = `${target.tabId ?? ""}:${target.experimentId}`;
    const genKey = `${key}\u0000${detailKey}`;
    const generation = (detailGeneration.get(genKey) ?? 0) + 1;
    detailGeneration.set(genKey, generation);
    patchCache(key, (prev) => ({
      detail: {
        ...prev.detail,
        [detailKey]: { load: "loading", value: prev.detail[detailKey]?.value ?? null },
      },
    }));
    let entry: ExperimentsCache["detail"][string];
    try {
      const value = await backendFor(target.instanceId).autoresearchExperiment(
        target.projectCwd,
        target.tabId,
        target.experimentId,
      );
      entry = { load: "ready", value };
    } catch (err) {
      entry = {
        load: "error",
        value: { record: null, runs: [], error: err instanceof Error ? err.message : String(err) },
      };
    }
    if (detailGeneration.get(genKey) !== generation) return;
    patchCache(key, (prev) => ({ detail: { ...prev.detail, [detailKey]: entry } }));
  };

  const stopRefresh = (): void => {
    if (refreshTimer === null) return;
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  };

  /** Re-reads what the open Lab shows; stops itself once the Lab is closed. */
  const refresh = (): void => {
    const lab = get().lab;
    if (lab === null) {
      stopRefresh();
      return;
    }
    if (lab.projectCwd !== null) void loadExperiments(lab.projectCwd, lab.instanceId);
    else
      for (const key of Object.keys(get().experiments)) {
        const { instanceId, path } = splitProjectKey(key);
        void loadExperiments(path, instanceId);
      }
    if (lab.experiment !== null) void loadExperimentDetail(lab.experiment);
  };

  const openLab: LabSlice["openLab"] = (projectCwd = null, instanceId = null, focus) => {
    let view: LabView = { projectCwd, instanceId, experiment: null };
    if (focus !== undefined) {
      const tab = get().tabs.find((candidate) => candidate.tabId === focus.tabId);
      if (tab !== undefined) {
        const record = findRecord(get().state, focus.tabId);
        const key = projectKey(tab.instanceId, tab.projectCwd);
        const link = linkedExperiment(get().experiments[key]?.result ?? null, focus.tabId, record);
        view = {
          projectCwd: tab.projectCwd,
          instanceId: tab.instanceId,
          experiment:
            link === null
              ? null
              : {
                  projectCwd: tab.projectCwd,
                  instanceId: tab.instanceId,
                  tabId: link.checkoutTabId,
                  experimentId: link.record.id,
                },
        };
      }
    }
    set({ lab: view });
    if (view.projectCwd !== null) void loadExperiments(view.projectCwd, view.instanceId);
    if (view.experiment !== null) void loadExperimentDetail(view.experiment);
    if (refreshTimer === null) refreshTimer = window.setInterval(refresh, LAB_REFRESH_MS);
  };

  const closeLab = (): void => {
    set({ lab: null });
    stopRefresh();
  };

  /** A live native session, or the notice naming why omp cannot be asked. */
  const controllable = (tabId: string): boolean => {
    const record = findRecord(get().state, tabId);
    if (record?.live !== "live") {
      get().reportError(new Error(t("lab.error.notLive")));
      return false;
    }
    if (record.mode !== "rpc-ui") {
      get().reportError(new Error(t("lab.error.notNative")));
      return false;
    }
    return true;
  };

  const newExperiment: LabSlice["newExperiment"] = async (projectCwd, spec, instanceId = null, gate) => {
    const { advisor, advisorModel } = await deps.resolveSpawnParams(
      projectCwd,
      { mode: "rpc-ui" },
      instanceId,
    );
    const key = projectKey(instanceId, projectCwd);
    const launchedBranch =
      spec.worktree?.mint.branch ?? get().branches[key]?.current ?? null;
    // A rejected spawn propagates: the dialog renders git's own message inline.
    const { tabId } = await backendFor(instanceId).spawnSession({
      origin: "new",
      projectCwd,
      mode: "rpc-ui",
      advisor,
      advisorModel,
      cols: 80,
      rows: 24,
      planMode: false,
      worktree: spec.worktree,
      experiment: {
        goal: spec.goal,
        metric: spec.metric,
        unit: spec.unit,
        direction: spec.direction,
        launchedBranch,
        launchedAt: new Date().toISOString(),
      },
    });
    set((s) => ({
      tabs: [...s.tabs, { tabId, mode: "rpc-ui", projectCwd, hidden: false, instanceId }],
      ...focusOn(s, tabId, key),
      exited: dropExited(s.exited, tabId),
      experimentDialog: null,
    }));
    if (gate !== undefined) {
      // The spawn succeeded: release the interview agent with the spec as launched.
      answerExperimentProposal(gate.tabId, experimentLaunchedValue({ branch: launchedBranch, ...proposalOf(spec) }));
    }
    openNextProposal();
    // Issue #405: the mint may have just created a base branch; surface it
    // in the lists without a network round trip.
    if (spec.worktree?.mint.baseBranch != null) {
      void get().refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
    }
    await m.pollUntil(
      tabId,
      (tab) => tab?.status === "ready" || tab?.status === "error" || get().exited[tabId] !== undefined,
    );
    if (get().rpc[tabId]?.status !== "ready") return;
    if (spec.model !== null) {
      const current = get().rpc[tabId]?.model;
      if (
        current === undefined ||
        current === null ||
        `${spec.model.provider}/${spec.model.id}` !== `${current.provider}/${current.id}`
      ) {
        await get().setModel(tabId, spec.model);
        if (get().rpc[tabId]?.failure?.command === "set_model") return;
      }
    }
    // Bare `/autoresearch` arms omp's mode (its own command, no dialog over
    // rpc); the kickoff then names the experiment through init_experiment.
    await get().runSlashCommand(tabId, "/autoresearch");
    await get().sendPrompt(tabId, experimentKickoff(spec, experimentSlug(spec.goal)), "prompt");
  };

  return {
    lab: null,
    experimentDialog: null,
    experiments: {},
    openLab,
    openLabExperiment(target) {
      // A detail opened from an overview keeps that overview's scope behind it.
      set((s) => ({
        lab:
          s.lab === null
            ? { projectCwd: target.projectCwd, instanceId: target.instanceId, experiment: target }
            : { ...s.lab, experiment: target },
      }));
      void loadExperimentDetail(target);
      if (refreshTimer === null) refreshTimer = window.setInterval(refresh, LAB_REFRESH_MS);
    },
    closeLab,
    openExperimentDialog(projectCwd, instanceId = null, proposalTabId) {
      set({
        experimentDialog: { projectCwd, instanceId, ...(proposalTabId === undefined ? {} : { proposalTabId }) },
      });
    },
    closeExperimentDialog() {
      set({ experimentDialog: null });
      openNextProposal();
    },
    acceptExperimentProposal,
    answerExperimentProposal,
    async startExperimentInterview(projectCwd, instanceId, description, inTab) {
      set({ experimentDialog: null });
      if (inTab !== undefined) {
        const unavailable = get().rpc[inTab]?.autoresearch?.proposeUnavailable ?? null;
        if (unavailable !== null) {
          get().reportError(new Error(t("experiment.interview.unavailable", { reason: unavailable })));
          return;
        }
        await get().sendPrompt(inTab, experimentInterviewPrompt(description), "prompt");
        return;
      }
      const { advisor, advisorModel } = await deps.resolveSpawnParams(projectCwd, { mode: "rpc-ui" }, instanceId);
      let tabId: string;
      try {
        ({ tabId } = await backendFor(instanceId).spawnSession({
          origin: "new",
          projectCwd,
          mode: "rpc-ui",
          advisor,
          advisorModel,
          cols: 80,
          rows: 24,
          worktree: null,
        }));
      } catch (err) {
        get().reportError(err); // no dialog is open to render it inline — the newSession posture
        return;
      }
      const key = projectKey(instanceId, projectCwd);
      set((s) => ({
        tabs: [...s.tabs, { tabId, mode: "rpc-ui", projectCwd, hidden: false, instanceId }],
        ...focusOn(s, tabId, key),
        exited: dropExited(s.exited, tabId),
      }));
      await m.pollUntil(
        tabId,
        (tab) => tab?.status === "ready" || tab?.status === "error" || get().exited[tabId] !== undefined,
      );
      if (get().rpc[tabId]?.status !== "ready") return;
      await get().sendPrompt(tabId, experimentInterviewPrompt(description), "prompt");
    },
    loadExperiments,
    loadExperimentDetail,
    newExperiment,
    async stopExperiment(tabId) {
      if (!controllable(tabId)) return;
      await get().runSlashCommand(tabId, "/autoresearch off");
    },
    async startNewSegment(tabId) {
      if (!controllable(tabId)) return;
      await get().sendPrompt(tabId, NEW_SEGMENT_PROMPT, "prompt");
    },
  };
}
