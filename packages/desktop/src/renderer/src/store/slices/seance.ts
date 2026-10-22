// Seance consult (issue #885): a read-only consultation of a saved session
// through omp's bundled `seance` task agent. omp has no rpc verb for seance,
// so the launch rides `prompt` — the kickoff composes the single `task` call
// — and follow-ups ride the existing `steer_subagent`. Consulting state is not
// stored here: the subagent roster filtered by `agent === "seance"` is the
// truth, and omp's hub persists the consultant's transcript for backfill.
import { backendFor } from "../../backend";
import { noticeItem } from "../../lib/transcript";
import { t } from "../../lib/i18n";
import { parseSeanceArgs } from "../../lib/seance-args";
import { seanceKickoff } from "../../lib/seance-kickoff";
import { SEANCE_MIN_OMP, supportsSeance } from "../../lib/seance";
import type { SessionSummary } from "@omp-ui/core/types";
import type { SeanceSlice, UiStore } from "../types";
import { dropExited, type GetState, type SetState, type StoreMachinery } from "./shared";
import { findOwner, findRecord, focusOn } from "./view";

export interface SeanceDeps {
  resolveSpawnParams(
    projectCwd: string,
    overrides?: { mode?: "rpc-ui" },
    instanceId?: string | null,
  ): Promise<{ advisor: boolean; advisorModel: string | null }>;
}

/** A session id/path token from `/seance` or the dialog, mapped to a launch spec. */
export interface ResolvedSeanceSource {
  /** Absolute transcript path when resolvable; else the verbatim token (omp's own error then speaks). */
  sourceSession: string;
  sourceLabel: string;
  /** Read privacy of the consulted source (issue #852), for the spawned consult session. */
  private: boolean;
}

/** Tokens with a path separator or transcript suffix take the task tool's path form directly. */
function looksLikePath(token: string): boolean {
  return /[/\\]/.test(token) || token.endsWith(".jsonl") || token.endsWith(".jsonl.gz");
}

/**
 * Maps one source token (session id, unique id prefix, or path) against the
 * registry: exact id first, then a unique prefix; a path token rides verbatim
 * (omp resolves it against the consulting session's cwd). Anything else stays
 * verbatim too — the task tool's own error sentence beats an omp-ui guess.
 */
export async function resolveSeanceSource(
  state: UiStore["state"],
  instanceId: string | null,
  token: string,
): Promise<ResolvedSeanceSource | null> {
  const candidates: SessionSummary[] = [];
  if (state !== null) {
    for (const group of state.projects) candidates.push(...group.sessions);
    candidates.push(...state.chats);
    for (const instance of state.remoteInstances) {
      if (instance.status !== "joined") continue;
      for (const group of instance.projects) candidates.push(...group.sessions);
    }
  }
  const owned = candidates.filter((s) => s.sessionId !== null);
  const exact = owned.find((s) => s.sessionId === token);
  const prefix = exact === undefined ? owned.filter((s) => s.sessionId!.startsWith(token)) : [];
  const match = exact ?? (prefix.length === 1 ? prefix[0]! : undefined);
  if (match !== undefined && match.sessionId !== null) {
    // The task-tool resolver only sees the consulting session's own dir for a
    // bare id (ADR-0003), so an owned match is upgraded to its transcript path.
    const path = await backendFor(instanceId).sessionTranscriptPath(match.tabId);
    return {
      sourceSession: path ?? token,
      sourceLabel: match.title,
      private: match.private,
    };
  }
  if (looksLikePath(token)) {
    return { sourceSession: token, sourceLabel: token, private: false };
  }
  return null;
}

export function createSeanceSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: SeanceDeps,
): SeanceSlice {
  const openSeanceDialog: SeanceSlice["openSeanceDialog"] = (init) => {
    set({ seanceDialog: init });
  };

  const closeSeanceDialog = (): void => {
    set({ seanceDialog: null });
  };

  const launchSeanceConsult: SeanceSlice["launchSeanceConsult"] = async (
    target,
    question,
    model = null,
  ) => {
    const spec = seanceKickoff({
      sourceSession: target.sourceSession,
      sourceLabel: target.sourceLabel,
      question,
      model,
    });
    if (target.tabId !== undefined) {
      // In place: the invoking live native tab hosts the consultant.
      const host = target.tabId;
      if (get().rpc[host]?.plan?.enabled === true) {
        // omp hides `sourceSession` from the task tool's schema while plan
        // mode is on (and filters bundled seance from the roster), so a
        // plan-mode host cannot spawn the consultant — the kickoff would
        // fail preflight. Run the consult in a fresh build-mode session
        // in the source's project instead.
        get().appendNotice(host, t("seance.dialog.planModeRedirect"), "warn");
      } else {
        if (get().rpc[host]?.status !== "ready") {
          get().appendNotice(host, t("composer.goal.notReady"), "warn");
          return;
        }
        await get().sendPrompt(host, spec, "prompt");
        return;
      }
    }
    // A fresh consult session in the source's project — never a wake of the
    // source itself (the property seance preserves). Privacy rides the spawn:
    // consulting a write-quiet session must not make its contents memorable.
    // A chat source has no project: its consult lands in a fresh chat.
    let tabId: string;
    if (target.chat === true) {
      const landed = await get().newChat(target.private === true ? { private: true } : {});
      set({ seanceDialog: null });
      if (landed === null) return;
      tabId = landed;
    } else {
      const { instanceId, projectCwd } = target;
      const { advisor, advisorModel } = await deps.resolveSpawnParams(
        projectCwd,
        { mode: "rpc-ui" },
        instanceId,
      );
      const spawned = await backendFor(instanceId).spawnSession({
        origin: "new",
        projectCwd,
        mode: "rpc-ui",
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
        planMode: false,
        worktree: null,
        ...(target.private === true ? { private: true } : {}),
      });
      tabId = spawned.tabId;
      set((s) => ({
        tabs: [...s.tabs, { tabId, mode: "rpc-ui", projectCwd, hidden: false, instanceId }],
        ...focusOn(tabId),
        exited: dropExited(s.exited, tabId),
        seanceDialog: null,
      }));
    }
    await m.pollUntilSettled(tabId);
    if (get().rpc[tabId]?.status !== "ready") {
      if (get().rpc[tabId]?.status !== "error" && get().exited[tabId] === undefined) {
        m.appendItem(tabId, noticeItem(t("seance.dialog.neverStarted"), "warn"));
      }
      return;
    }
    // No applyStagedParams: the model override selects the consultant's model
    // inside the task call, not this session's.
    await get().sendPrompt(tabId, spec, "prompt");
  };

  const runSeanceLine: SeanceSlice["runSeanceLine"] = async (tabId, line) => {
    // Always consumed in native tabs (the localCommands entry gates tab mode):
    // forwarding `/seance …` as prose would reach the model as a literal.
    get().focusRailPane(tabId, "seance");
    if (!supportsSeance(get().rpc[tabId]?.capabilities?.ompVersion ?? null)) {
      get().appendNotice(
        tabId,
        t("rail.seance.needsNewerOmp", { version: SEANCE_MIN_OMP }),
        "warn",
      );
      return;
    }
    const args = parseSeanceArgs(line.replace(/^\/seance\b/i, ""));
    if (args.error !== undefined) {
      get().appendNotice(tabId, args.error, "warn");
      return;
    }
    const tab = get().tabs.find((candidate) => candidate.tabId === tabId);
    get().openSeanceDialog({
      projectCwd: tab?.projectCwd ?? "",
      instanceId: tab?.instanceId ?? null,
      sourceTabId: tabId,
      ...(args.source === undefined && args.model === undefined
        ? {}
        : { prefill: { ...(args.source === undefined ? {} : { source: args.source }), ...(args.model === undefined ? {} : { model: args.model }) } }),
    });
  };

  const consultFromRow: SeanceSlice["consultFromRow"] = async (sourceTabId) => {
    const owner = findOwner(get().state, sourceTabId);
    const record = owner?.record ?? findRecord(get().state, sourceTabId);
    if (record === undefined || record.sessionId === null) {
      // Backstop for the hidden row affordance: nothing saved to consult.
      get().reportError(new Error(t("seance.dialog.noTranscript")));
      return;
    }
    const instanceId = owner?.instanceId ?? null;
    const transcript = await backendFor(instanceId).sessionTranscriptPath(sourceTabId);
    if (transcript === null) {
      get().reportError(new Error(t("seance.dialog.noTranscript")));
      return;
    }
    // One click, no dialog: a report-style consult in a fresh session. The
    // rail pane's dialog offers source/model choice where a picker is on-surface.
    await launchSeanceConsult(
      {
        projectCwd: record.projectCwd,
        instanceId,
        sourceSession: transcript,
        sourceLabel: record.title,
        private: record.private,
        chat: record.chat,
      },
      t("seance.dialog.defaultQuestion"),
    );
  };

  return {
    seanceDialog: null,
    openSeanceDialog,
    closeSeanceDialog,
    launchSeanceConsult,
    runSeanceLine,
    consultFromRow,
  };
}
