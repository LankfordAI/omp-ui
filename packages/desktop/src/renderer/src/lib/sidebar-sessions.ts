import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import type { UnreadMark } from "../store/slices/unread";
import { projectFaceFor, projectIconUrl, type ProjectFace } from "./repository-members";
import { NO_HANDOFF, resolveSessionHandoffs, type SessionHandoff } from "./session-handoffs";
import { NO_DISPATCH, resolveDispatchLinks, type SessionDispatch } from "./dispatched-sessions";

export interface SidebarEntry {
  session: SessionSummary;
  /** Owning instance; null = this app. */
  instanceId: string | null;
  /** Owning instance's nickname; null = this app. */
  nickname: string | null;
  /** The project's face; null for a chat. */
  project: ProjectFace | null;
  /** False while the owning instance's status is not "joined": the row dims and opens no menu. */
  reachable: boolean;
  handoff: SessionHandoff;
  /** Dispatch tether links (#1226): the dispatching session and the sessions this one dispatched. */
  dispatch: SessionDispatch;
}

export interface SidebarLists {
  /** live and pinned (`pinnedAtMs !== null`), whatever its turn or snooze —
   *  earliest pin first, so pinning a row never moves another (issue #981). */
  pinned: SidebarEntry[];
  /** live and either not in a turn or blocked on the user (pending plan / human answer), not pinned or snoozed — newest open first. */
  active: SidebarEntry[];
  /** live with a running turn or a running background job and not blocked on
   *  the user, not pinned or snoozed — newest open first. */
  working: SidebarEntry[];
  /** snoozed === true and not live-pinned — newest open first. Always empty
   *  while the snoozedSectionEnabled setting is off (issue #935). */
  snoozed: SidebarEntry[];
  /** Not live and not snoozed (dormant, archived, missing) — newest open
   *  first. A pinned record that is not live lands here, pin intact. */
  settled: SidebarEntry[];
}

/** Open-order key (#921): when omp-ui opened the session. An unparseable stamp sorts last. */
function openOrderOf(s: SessionSummary): number {
  const t = Date.parse(s.launchedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function matches(entry: SidebarEntry, q: string): boolean {
  // Saved plan metadata is unvalidated on disk; read the title only when it is a string.
  const planTitle = entry.session.planImplementationSource?.planTitle;
  return (
    entry.session.title.toLowerCase().includes(q) ||
    (typeof planTitle === "string" && planTitle.toLowerCase().includes(q)) ||
    (entry.project?.name.toLowerCase().includes(q) ?? false) ||
    (entry.nickname?.toLowerCase().includes(q) ?? false)
  );
}

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set();

/**
 * Content signature of every input `buildSidebarLists`, `buildAttentionEntries`,
 * and the row renderers read: per-session summaries in full (a hand-picked
 * field list drifts — SessionRow renders `snoozedUntilMs`, `model`, PR links,
 * and more, so any enumeration is one broadcast away from a stale row),
 * project faces (name, repository key, icon), remote instance metadata
 * (nickname, reachability, dispatch), the search query, background-work ids,
 * and suppression ids. Equal string ⇒ equal rendered output, so the Sidebar
 * can gate its rebuilds on this primitive instead of `BackendState` identity —
 * every broadcast delivers fresh IPC-deserialized summaries whose object
 * identities all change, while the content usually does not. Key order is the
 * constructor's on every host (same JSON.parse/serialize path), so plain
 * JSON.stringify is a faithful per-row encoding; cheap string work over the
 * rows, no React commit.
 */
export function sidebarListsSignature(
  state: BackendState,
  query: string,
  backgroundWorkTabIds: ReadonlySet<string>,
  suppressTabIds: ReadonlySet<string>,
): string {
  const parts: string[] = [
    query.trim().toLowerCase(),
    // Membership is all the builder tests, so sorted ids are a faithful encoding.
    [...backgroundWorkTabIds].sort().join(","),
    [...suppressTabIds].sort().join(","),
  ];
  const visit = (s: SessionSummary): void => {
    parts.push(JSON.stringify(s));
  };
  for (const group of state.projects) {
    const p = group.project;
    parts.push(
      `p\u0000${p.path}\u0000${p.name}\u0000${p.repositoryKey ?? ""}\u0000${projectIconUrl(p.icon) ?? ""}`,
    );
    for (const s of group.sessions) visit(s);
  }
  for (const s of state.chats) visit(s);
  for (const instance of state.remoteInstances) {
    parts.push(`i\u0000${instance.id}\u0000${instance.nickname ?? ""}\u0000${instance.status}`);
    if (instance.status === "self") continue;
    for (const group of instance.projects) {
      const p = group.project;
      parts.push(
        `p\u0000${instance.id}\u0000${p.path}\u0000${p.name}\u0000${p.repositoryKey ?? ""}\u0000${projectIconUrl(p.icon) ?? ""}`,
      );
      for (const s of group.sessions) visit(s);
    }
  }
  return parts.join("\u0002");
}

/**
 * Whether a session is a Routine run (ADR-0100, #1255, #1304): attention-only
 * on every host (local or joined remote), so it never files into a coding
 * section or the footer live/working counts. An older remote host that
 * publishes no `routine` key reads as no run.
 */
export function isRoutineRun(s: SessionSummary): boolean {
  return s.routine != null;
}

/**
 * Whether a session belongs to Settled (issue #1137):
 * - A live session is never settled.
 * - Archived and missing transcripts cannot run in place and always file to Settled.
 * - On hosts that publish `settledAtMs`, a numeric stamp marks a settled session,
 *   while `settledAtMs === null` keeps a dormant session in the active/pinned lists.
 * - On an older remote host where `settledAtMs` is `undefined`, fall back to `s.live !== "live"`.
 */
export function isSessionSettled(s: SessionSummary): boolean {
  if (s.live === "live") return false;
  if (s.live === "archived" || s.live === "missing") return true;
  if (s.settledAtMs !== undefined) return s.settledAtMs !== null;
  return true;
}

/**
 * The sidebar's session lists: every local project session and chat plus
 * every non-self remote instance's sessions, filtered by `query`, sorted
 * newest open first by `launchedAt` (ties keep build order), and split into
 * five sections — pinned (live and pinned, earliest pin first), active (live,
 * no running turn or blocked on the user), working (live with a running turn,
 * not blocked on the user), snoozed (parked via the sidebar, when the
 * snoozedSectionEnabled setting is on), and settled (not live, not
 * snoozed). Handoffs resolve per host over that host's full session set,
 * before any filtering or partitioning, so a live implementation still
 * finds its settled planning session.
 *
 * `backgroundWorkTabIds` carries the tabs whose bridge snapshot reports a running
 * background job (issue #1026): like a running turn, that work needs nothing from
 * the user, so those rows join Working. The caller builds the set from its own
 * renderer state: every live rpc-ui tab it holds an async-jobs snapshot for,
 * local or remote. A remote row this renderer never mounted has no snapshot and
 * keeps the host-published `turnRunning` level alone.
 */
export function buildSidebarLists(
  state: BackendState,
  query: string,
  backgroundWorkTabIds: ReadonlySet<string> = EMPTY_TAB_IDS,
  /** Rows surfaced as attention-stack cards (#1038): suppressed from every
   *  list while their card heads the stack, so a flagged session reads once. */
  suppressTabIds: ReadonlySet<string> = EMPTY_TAB_IDS,
): SidebarLists {
  const entries: SidebarEntry[] = [];
  const dispatch = resolveDispatchLinks(state);

  const local: SessionSummary[] = [];
  for (const group of state.projects) local.push(...group.sessions);
  local.push(...state.chats);
  const localHandoffs = resolveSessionHandoffs(local);
  for (const group of state.projects) {
    for (const session of group.sessions) {
      if (isRoutineRun(session)) continue;
      entries.push({
        session,
        instanceId: null,
        nickname: null,
        project: projectFaceFor(state, null, group.project),
        reachable: true,
        handoff: localHandoffs.get(session.tabId) ?? NO_HANDOFF,
        dispatch: dispatch.get(session.tabId) ?? NO_DISPATCH,
      });
    }
  }
  for (const session of state.chats) {
    if (isRoutineRun(session)) continue;
    entries.push({
      session,
      instanceId: null,
      nickname: null,
      project: null,
      reachable: true,
      handoff: localHandoffs.get(session.tabId) ?? NO_HANDOFF,
      dispatch: dispatch.get(session.tabId) ?? NO_DISPATCH,
    });
  }

  for (const instance of state.remoteInstances) {
    if (instance.status === "self") continue;
    const handoffs = resolveSessionHandoffs(instance.projects.flatMap((group) => group.sessions));
    const reachable = instance.status === "joined";
    for (const group of instance.projects) {
      for (const session of group.sessions) {
        if (isRoutineRun(session)) continue;
        entries.push({
          session,
          instanceId: instance.id,
          nickname: instance.nickname,
          project: projectFaceFor(state, instance.id, group.project),
          reachable,
          handoff: handoffs.get(session.tabId) ?? NO_HANDOFF,
          dispatch: dispatch.get(session.tabId) ?? NO_DISPATCH,
        });
      }
    }
  }

  const q = query.trim().toLowerCase();
  const kept = q.length === 0 ? entries : entries.filter((entry) => matches(entry, q));

  // Never subtract: -Infinity - -Infinity is NaN. Array#sort is stable, so ties
  // keep build order.
  kept.sort((a, b) => {
    const x = openOrderOf(b.session);
    const y = openOrderOf(a.session);
    return x === y ? 0 : x > y ? 1 : -1;
  });

  const pinned: SidebarEntry[] = [];
  const active: SidebarEntry[] = [];
  const working: SidebarEntry[] = [];
  const snoozed: SidebarEntry[] = [];
  const settled: SidebarEntry[] = [];
  for (const entry of kept) {
    const s = entry.session;
    // A flagged session reads once (#1038): the caller suppresses exactly the
    // tabIds whose card heads the stack, so the row returns when the mark
    // clears. Marked-but-working sessions are not in the set — no card, row
    // stays where its state puts it.
    if (suppressTabIds.has(s.tabId)) continue;
    // Snoozed outranks every other placement, including Pinned (#1323): a
    // pinned session keeps its `pinnedAtMs` while snoozed so waking or
    // unsnoozing restores its exact slot in Pinned.
    if (s.snoozed === true) {
      snoozed.push(entry);
      continue;
    }
    // An unsettled pinned session stays in Pinned mid-turn and across app
    // restarts/reboots: the pin is the user's "keep this in view" (issues
    // #981, #1137). Settled still wins — a settled pin files below with the
    // rest, and returns on resume. An older remote host publishes no
    // pinnedAtMs; absent reads as unpinned.
    const isSettled = isSessionSettled(s);
    if (!isSettled && typeof s.pinnedAtMs === "number") {
      pinned.push(entry);
      continue;
    }
    if (isSettled) {
      settled.push(entry);
      continue;
    }
    // the main list even mid-turn: Working is for sessions that need nothing
    // from the user (issue #944). Both are host-published levels, so remote rows
    // move too. A terminal or dormant session never reports turnRunning, so it
    // can never land in Working; an older remote host's absent latch reads the
    // same way. Background work that outlives its dispatching turn counts
    // exactly as the row's chip counts it (issue #851, placement fixed by issue
    // #1026): the caller passes the local tabs whose async-jobs snapshot has a
    // running job.
    const needsUser = s.pendingPlan !== null || s.awaitingHumanAnswer === true;
    const workInFlight = s.live === "live" && (s.turnRunning === true || backgroundWorkTabIds.has(s.tabId));
    if (workInFlight && !needsUser) working.push(entry);
    else active.push(entry);
  }
  // Pin time is a fixed rule, not a hand-kept order (ADR-0067 rejects manual
  // reordering). Stable sort: equal stamps keep open order.
  pinned.sort((a, b) => (a.session.pinnedAtMs as number) - (b.session.pinnedAtMs as number));
  return { pinned, active, working, snoozed, settled };
}

/** One attention-stack card (#1037): a flagged session, its mark, and the
 *  derived state the filter proved it in. */
export interface AttentionEntry {
  entry: SidebarEntry;
  mark: UnreadMark;
  /** Derived sidebar state at build time; guaranteed ready, awaiting-answer, or reminder. */
  state: "ready" | "awaiting-answer" | "reminder";
}

/**
 * The attention stack (issues #1037, #1323):
 * - Every flagged local session whose derived state is `ready` or `awaiting-answer`
 *   — a mark on a session that went back to work (or settled/died) waits for the next unseen reply.
 * - Every unsettled, non-snoozed session (local or joined remote, including dormant)
 *   whose timed snooze expired (`reminderAtMs !== null`), surfaced as `"reminder"`
 *   unless a higher-priority live `awaiting-answer` state applies.
 * - Every live Routine run parked on an Approval card (local or joined remote) as
 *   `awaiting-answer` without needing a mark (ADR-0100, #1304, #1305).
 * The stack is unfiltered by the sidebar search query on purpose — a flagged
 * session surfaces even while the user is filtering or a section is collapsed.
 * Newest mark first.
 */
export function buildAttentionEntries(
  state: BackendState,
  unread: Readonly<Record<string, UnreadMark>>,
  derive: (s: SessionSummary) => string,
): AttentionEntry[] {
  const out: AttentionEntry[] = [];
  const dispatch = resolveDispatchLinks(state);
  const visit = (
    session: SessionSummary,
    project: ProjectFace | null,
    instanceId: string | null,
    nickname: string | null,
  ): void => {
    // A snoozed row never sits in Needs attention (#1323).
    if (session.snoozed === true) return;
    // A Routine run parked on an Approval card needs a person whether or not
    // this renderer saw the reply that raised it (a client that connected
    // later, or a joined remote host, holds no mark): it is attention-only, so
    // this card is its one place in the sidebar (ADR-0100, #1255, #1304).
    const waitingRun = isRoutineRun(session) && session.live === "live" && session.awaitingHumanAnswer === true;
    // A host-persisted timed-snooze reminder surfaces even while dormant (#1323).
    const reminderDue = !isRoutineRun(session) && !isSessionSettled(session) && typeof session.reminderAtMs === "number";
    const unreadMark = instanceId === null ? unread[session.tabId] : undefined;
    const mark =
      unreadMark ??
      (waitingRun
        ? { atMs: Number.isFinite(openOrderOf(session)) ? openOrderOf(session) : 0, snippet: null }
        : reminderDue
          ? { atMs: session.reminderAtMs as number, snippet: null }
          : undefined);
    if (mark === undefined) return;
    const derived = derive(session);
    let kept: AttentionEntry["state"] | null;
    let entryMark: UnreadMark = mark;
    if (derived === "awaiting-answer") {
      kept = "awaiting-answer";
    } else if (reminderDue) {
      kept = "reminder";
      entryMark = { atMs: session.reminderAtMs as number, snippet: null };
    } else if (derived === "ready") {
      kept = "ready";
    } else if (isRoutineRun(session) && session.live === "live" && derived === "live") {
      // A live Routine run in its 60 s post-end grace that no tab ever mounted
      // derives bare idle "live" — keep it as "ready" while live, and drop it as
      // soon as self-Settle makes it dormant (#1305).
      kept = "ready";
    } else {
      kept = null;
    }
    if (kept === null) return;
    out.push({
      entry: {
        session,
        instanceId,
        nickname,
        project,
        reachable: true,
        handoff: NO_HANDOFF,
        dispatch: dispatch.get(session.tabId) ?? NO_DISPATCH,
      },
      mark: entryMark,
      state: kept,
    });
  };
  for (const group of state.projects) {
    for (const session of group.sessions) visit(session, projectFaceFor(state, null, group.project), null, null);
  }
  for (const session of state.chats) visit(session, null, null, null);
  for (const instance of state.remoteInstances) {
    if (instance.status !== "joined") continue;
    for (const group of instance.projects) {
      for (const session of group.sessions) {
        const waitingRun = isRoutineRun(session) && session.live === "live" && session.awaitingHumanAnswer === true;
        const reminderDue = !isRoutineRun(session) && !isSessionSettled(session) && session.snoozed !== true && typeof session.reminderAtMs === "number";
        if (!waitingRun && !reminderDue) continue;
        visit(
          session,
          projectFaceFor(state, instance.id, group.project),
          instance.id,
          instance.nickname,
        );
      }
    }
  }
  out.sort((a, b) => b.mark.atMs - a.mark.atMs);
  return out;
}
