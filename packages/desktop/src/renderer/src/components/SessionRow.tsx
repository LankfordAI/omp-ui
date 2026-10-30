import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { relativeTime } from "../lib/format";
import { tileModel, tileQuote } from "../lib/session-tile";
import type { SessionSummary } from "@omp-ui/core/types";
import { parseTitleCard } from "@omp-ui/core/title-card";
import { localeTag, useT, type MessageKey } from "../lib/i18n";
import { useKeybindingLabel } from "../lib/keybindings";
import { formatSnoozeUntil } from "../lib/snooze-until";
import { cn } from "../lib/cn";
import { canSettle, deriveSidebarSessionState, useStore, type SidebarSessionState } from "../store";
import { SEANCE_MIN_OMP, supportsSeance } from "../lib/seance";
import { SESSION_DRAG_EFFECT, SESSION_DRAG_MIME } from "../lib/session-drag";
import { Button, Chip, Dot, IconButton, IconClock, IconLock, IconPin, IconSpeaker, type Tone } from "./ui";
import type { SessionHandoff } from "../lib/session-handoffs";
import { openPullRequest, pullRequestFace, PullRequestChip } from "./PullRequestChip";
import { liveDisplayPhase, type LiveDisplayPhase } from "@omp-ui/core/live-voice";

/** One session state's sidebar face; the Fleet view's dispatch rows reuse it (issue #899). */
export const SESSION_FACE: Record<
  SidebarSessionState,
  { tone: Tone; pulse: boolean; labelKey: MessageKey; titleKey: MessageKey; textClass: string }
> = {
  working: {
    tone: "copper",
    pulse: true,
    labelKey: "sidebar.status.workingLabel",
    titleKey: "sidebar.status.workingTitle",
    textClass: "text-copper",
  },
  "awaiting-answer": {
    tone: "iris",
    pulse: false,
    labelKey: "sidebar.status.answerLabel",
    titleKey: "sidebar.status.answerTitle",
    textClass: "text-iris",
  },
  stalled: {
    tone: "copper",
    pulse: false,
    labelKey: "sidebar.status.stalledLabel",
    titleKey: "sidebar.status.stalledTitle",
    textClass: "text-copper",
  },
  ready: {
    tone: "signal",
    pulse: false,
    labelKey: "sidebar.status.readyLabel",
    titleKey: "sidebar.status.readyTitle",
    textClass: "text-signal",
  },
  starting: {
    tone: "neutral",
    pulse: true,
    labelKey: "sidebar.status.startingLabel",
    titleKey: "sidebar.status.startingTitle",
    textClass: "text-ink-mid",
  },
  error: {
    tone: "rose",
    pulse: false,
    labelKey: "sidebar.status.errorLabel",
    titleKey: "sidebar.status.errorTitle",
    textClass: "text-rose",
  },
  live: {
    tone: "signal",
    pulse: false,
    labelKey: "sidebar.status.liveLabel",
    titleKey: "sidebar.status.liveTitle",
    textClass: "text-signal",
  },
  dormant: {
    tone: "neutral",
    pulse: false,
    labelKey: "sidebar.status.dormantLabel",
    titleKey: "sidebar.status.dormantTitle",
    textClass: "text-ink-mid",
  },
  archived: {
    tone: "copper",
    pulse: false,
    labelKey: "sidebar.status.archivedLabel",
    titleKey: "sidebar.status.archivedTitle",
    textClass: "text-copper",
  },
  missing: {
    tone: "rose",
    pulse: false,
    labelKey: "sidebar.status.missingLabel",
    titleKey: "sidebar.session.missingHint",
    textClass: "text-rose",
  },
};

// Live voice output (issue #807): phase → the existing composer phase label.
const LIVE_PHASE_TITLE: Record<LiveDisplayPhase, MessageKey> = {
  connecting: "composer.live.phaseConnecting",
  listening: "composer.live.phaseListening",
  working: "composer.live.phaseWorking",
  speaking: "composer.live.phaseSpeaking",
  ready: "composer.live.phaseReady",
  error: "composer.live.phaseError",
};

function absoluteTime(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const d = new Date(then);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function IconTrash() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 5h10M6.5 5V3.5h3V5M4.5 5l.6 7.5h5.8L11.5 5M6.8 7.3v3M9.2 7.3v3" />
    </svg>
  );
}

function IconPower() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M8 2V7.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <path
        d="M4.6 4.6a4.8 4.8 0 106.8 0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A check — the row's Settle action, "done with this" (issue #980). */
function IconSettle() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** A pull request's two branch dots and merge arrow — the row's open-PR action (issue #985). */
function IconPullRequest() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7M8.5 3l-1.5 1.5L8.5 6" />
    </svg>
  );
}

/** A small plan document — the row's link back to the planning session (issue #238). */
function IconPlan() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M6 7.5h4M6 10h4" />
    </svg>
  );
}

/** A small ghost — the row's Seance consult action (issue #885). */
function IconSeance() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 13.5V7a4 4 0 018 0v6.5l-1.3-1-1.3 1-1.4-1-1.4 1-1.3-1z" />
      <path d="M6.4 7.2v.8M9.6 7.2v.8" />
    </svg>
  );
}

export function SessionRow({
  s,
  onActivate,
  handoff,
  projectLabel,
  instanceNickname = null,
  onContextMenu,
  density = "tile",
  multiSelected = false,
  onModifierClick,
}: {
  s: SessionSummary;
  onActivate?: () => void;
  /** Plan-handoff view of this row (issue #238): its resolved source, an
   *  orphan marker, and whether it dispatched at least one implementation. */
  handoff?: SessionHandoff;
  /** The row's project name, or the chat label; shown after the state label. */
  projectLabel?: string;
  /** Non-null on rows whose session lives on a joined remote instance; the
   *  meta line then names that machine (#903). */
  instanceNickname?: string | null;
  /** Right-click (or keyboard menu) on the row; Sidebar owns the portal. */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** tile: the three-line card (main list, Working, Snoozed); slim: the
   *  two-line Settled row (issue #938). */
  density?: "tile" | "slim";
  /** In the sidebar's multi-selection (issue #988): the row takes the selected treatment. */
  multiSelected?: boolean;
  /** Mod/Shift+click on the row (issue #988); true = consumed as a selection
   *  gesture, so the row does not open its session. */
  onModifierClick?: (event: ReactMouseEvent<HTMLButtonElement>) => boolean;
}) {
  const t = useT();
  const holdLabel = useKeybindingLabel("holdToTalk");
  const openSession = useStore((st) => st.openSession);
  const deleteSession = useStore((st) => st.deleteSession);
  const terminate = useStore((st) => st.terminate);
  const resumeDead = useStore((st) => st.resumeDead);
  const settleSessions = useStore((st) => st.settleSessions);
  // Settle (issue #980): finished work only — a row mid-turn keeps Stop.
  const settleable = useStore((st) =>
    canSettle(s, st.rpc[s.tabId]?.status === "running", st.state?.snoozedSectionEnabled === true),
  );
  const exited = useStore((st) => st.exited[s.tabId]);
  // Issue #926 — a settle hides the dead tab even for a record that never
  // materialized on disk, so the missing row must still be able to un-hide
  // it; opening a MOUNTED missing tab never spawns — openSession's
  // existing-tab branch only unhides and focuses.
  const tabMounted = useStore((st) => st.tabs.some((t) => t.tabId === s.tabId));
  const sidebarState = useStore((st) => deriveSidebarSessionState(s, st.rpc[s.tabId]));
  const activeTabId = useStore((st) => st.activeTabId);
  const consultFromRow = useStore((st) => st.consultFromRow);
  // Seance consult (issue #885): the floor rides the installed binary's
  // version, the same source SessionHud gates anonymize on — a dormant row
  // can be consulted from any project, so no per-tab ompVersion exists here.
  const seanceAvailable = useStore((st) => supportsSeance(st.ompUpdate.installedVersion));

  // Live voice output (issue #807) plus the park/resume badges (#811): a
  // running live session speaks even when its tab is not visible, and the
  // row says what a closed call is waiting for. The selector reads phase,
  // not the snapshot, so the peer's 10 Hz level patches never re-render the
  // row; `ended` swaps the phase glyph for the runtime badge mirror —
  // results waiting outranks merely-ready, and a tab with no live voice at
  // all (no key) stays bare.
  const liveBadge = useStore((st): LiveDisplayPhase | "armed" | "pending" | null => {
    if (s.mode !== "rpc-ui") return null;
    const live = st.rpc[s.tabId]?.live;
    if (live !== undefined && live !== null && !live.ended) {
      return liveDisplayPhase(live, {
        talking: st.liveVoice[s.tabId]?.talking === true,
        working: st.rpc[s.tabId]?.status === "running",
      });
    }
    const badge = st.liveVoice[s.tabId];
    if (badge === undefined) return null;
    return badge.pending ? "pending" : badge.armed ? "armed" : null;
  });

  const missing = s.live === "missing";
  const selected = s.tabId === activeTabId;
  // A settled dead tab waiting to be resurfaced (issue #926).
  const strandedSettle = missing && exited !== undefined && tabMounted;
  const rpc = s.mode === "rpc-ui";
  const when = relativeTime(s.cachedModified);
  const face = SESSION_FACE[sidebarState];
  // omp's title card (issue #838): the icon/code ride inside the title
  // string itself; recognized at render time, never stored. The tooltip and
  // every search/filter path keep the raw string — the card verbatim is the
  // unambiguous identity, and searching "PLAN" must still find the row.
  const card = parseTitleCard(s.title);
  const showPersistedStatus = !(s.live === "live" && rpc);

  // Plan handoff (issue #238). The dispatch snapshot lives on the row's own
  // record; the resolver turns it into a live source or an orphan marker.
  // The saved local:// plan path is deliberately never rendered.
  const source = handoff?.source ?? null;
  const orphanSource = handoff?.orphanSource ?? null;
  const planTitle = (orphanSource ?? s.planImplementationSource)?.planTitle ?? null;
  const implementsNote =
    source !== null && planTitle !== null
      ? t("sidebar.session.implementsFrom", { planTitle, sourceTitle: source.title })
      : orphanSource !== null
        ? t("sidebar.session.implementsUnavailable", { planTitle: orphanSource.planTitle })
        : null;

  // Issue #938: the tile's extra lines. Slim rows skip the derivations.
  const slim = density === "slim";
  const quote = slim ? null : tileQuote(s);
  const model = slim ? null : tileModel(s);
  // agentMode records the last rpc-ui incarnation, so a terminal tab never shows it.
  const planMode = rpc && s.agentMode === "plan";
  const impl = source !== null || orphanSource !== null;

  // Status indicators, shared by both densities; never in the hover cluster.
  const lockMark = s.private ? (
    <span
      role="img"
      aria-label={t("session.badge.private")}
      title={t("session.badge.private")}
      className="shrink-0 self-center text-ink-faint"
    >
      <IconLock />
    </span>
  ) : null;
  // Pinned (#981): an older remote host publishes no pinnedAtMs — absent is unpinned.
  const pinMark =
    typeof s.pinnedAtMs === "number" ? (
      <span
        role="img"
        aria-label={t("sidebar.session.pinned")}
        title={t("sidebar.session.pinned")}
        className="shrink-0 self-center text-ink-faint"
      >
        <IconPin />
      </span>
    ) : null;
  // Scheduled prompt (#987): a clock glyph and the next run. An older remote
  // host publishes no scheduledPrompt — absent is none.
  const nextRunAtMs = s.scheduledPrompt?.nextRunAtMs ?? null;
  const scheduleLabel =
    nextRunAtMs === null ? null : t("sidebar.session.nextRun", { when: formatSnoozeUntil(nextRunAtMs, new Date(), localeTag()) });
  const clockMark =
    s.scheduledPrompt != null ? (
      <span
        role="img"
        data-schedule-mark
        aria-label={scheduleLabel ?? t("sidebar.session.scheduled")}
        title={scheduleLabel ?? t("sidebar.session.scheduled")}
        className="shrink-0 self-center text-ink-faint"
      >
        <IconClock />
      </span>
    ) : null;
  const voiceMark =
    liveBadge !== null ? (
      <span
        role="img"
        aria-label={
          liveBadge === "armed"
            ? t("sidebar.session.liveVoiceArmed")
            : liveBadge === "pending"
              ? t("sidebar.session.liveVoicePending")
              : t("sidebar.session.liveVoice", { phase: t(LIVE_PHASE_TITLE[liveBadge], { key: holdLabel }) })
        }
        title={
          liveBadge === "armed"
            ? t("sidebar.session.liveVoiceArmed")
            : liveBadge === "pending"
              ? t("sidebar.session.liveVoicePending")
              : t("sidebar.session.liveVoice", { phase: t(LIVE_PHASE_TITLE[liveBadge], { key: holdLabel }) })
        }
        className={cn(
          "shrink-0 self-center",
          liveBadge === "speaking" || liveBadge === "pending"
            ? "text-signal"
            : liveBadge === "error"
              ? "text-rose"
              : liveBadge === "ready" || liveBadge === "armed"
                ? "text-ink-faint"
                : "text-ink-mid",
        )}
      >
        <IconSpeaker waves={liveBadge === "speaking" ? 2 : 1} />
      </span>
    ) : null;
  // Linked pull requests (#985): an older remote host publishes none.
  const pullRequests = s.pullRequests ?? [];
  const firstPr = pullRequests[0];
  const prChip = firstPr !== undefined ? <PullRequestChip links={pullRequests} interactive={false} /> : null;

  // Line 2: project · branch · machine; the slim row leads with its state.
  // The machine stays an inline span: a `<Chip>` would break the ellipsis.
  const meta: ReactNode[] = [];
  if (slim) {
    meta.push(<span className={face.textClass}>{t(face.labelKey)}</span>);
    if (showPersistedStatus && s.status) meta.push(s.status);
  }
  if (projectLabel) meta.push(projectLabel);
  if (s.worktree) meta.push(<span title={s.worktree.path}>⎇ {s.worktree.branch}</span>);
  if (instanceNickname) {
    meta.push(
      <span title={t("sidebar.session.machine", { machine: instanceNickname })}>{instanceNickname}</span>,
    );
  }
  // Timed snooze (#979) names its deadline: "snoozed until Tue 09:00".
  const snoozedLabel =
    s.snoozed !== true
      ? null
      : s.snoozedUntilMs === null
        ? t("sidebar.session.snoozed")
        : t("sidebar.session.snoozedUntil", { when: formatSnoozeUntil(s.snoozedUntilMs, new Date(), localeTag()) });
  if (slim && snoozedLabel !== null) meta.push(snoozedLabel);
  if (slim && scheduleLabel !== null) meta.push(scheduleLabel);

  return (
    <div
      onContextMenu={onContextMenu}
      // A drag source for session references (issue #984): drop on a native
      // composer to hand this session over. A missing row has nothing saved.
      draggable={!missing}
      onDragStart={(event) => {
        event.dataTransfer.setData(SESSION_DRAG_MIME, s.tabId);
        event.dataTransfer.effectAllowed = SESSION_DRAG_EFFECT;
      }}
      className={cn(
        "group/row animate-slide-in relative rounded-md transition-colors duration-150",
        selected || multiSelected ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      {(selected || multiSelected) && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-signal"
        />
      )}

      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        data-multi-selected={multiSelected ? "true" : undefined}
        title={
          missing && !strandedSettle ? t("sidebar.session.missingHint") : implementsNote !== null ? `${s.title} — ${implementsNote}` : s.title
        }
        // Shift+click extends the selection: keep the browser from also
        // selecting the text between the anchor and this row (issue #988).
        onMouseDown={(event) => {
          if (event.shiftKey && onModifierClick !== undefined) event.preventDefault();
        }}
        onClick={(event) => {
          if (onModifierClick?.(event) === true) return;
          if (missing && !strandedSettle) return;
          void openSession(s.tabId);
          onActivate?.();
        }}
        className={cn(
          "block w-full min-w-0 px-3 text-left",
          slim ? "py-1.5" : "py-2",
          missing && !strandedSettle && "cursor-default",
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          {slim && <Dot tone={face.tone} pulse={face.pulse} title={t(face.titleKey)} className="mt-1.5" />}
          <span
            data-session-tile-title
            className={cn(
              "min-w-0 flex-1 transition-colors duration-150",
              slim ? "truncate text-xs" : "line-clamp-2 break-words text-[13.5px] leading-snug",
              missing ? "text-ink-faint" : "text-ink-mid group-hover/row:text-ink",
              selected && !missing && "text-ink",
            )}
          >
            {card === null ? (
              s.title
            ) : (
              <>
                {card.icon !== null && (
                  <span aria-hidden className="mr-1">
                    {card.icon}
                  </span>
                )}
                <span className="mr-1.5 rounded bg-raised px-1 font-mono text-[10px] tracking-wide text-ink-mid">
                  {card.code}
                </span>
                <span>{card.title}</span>
              </>
            )}
          </span>
          {slim && prChip}
          {slim && pinMark}
          {slim && clockMark}
          {slim && lockMark}
          {slim && voiceMark}
          {when && (
            <span
              title={absoluteTime(s.cachedModified)}
              className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-ink-faint"
            >
              {when}
            </span>
          )}
        </span>

        {meta.length > 0 && (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-faint">
            {meta.map((node, i) => (
              <Fragment key={i}>
                {i > 0 ? " · " : null}
                {node}
              </Fragment>
            ))}
          </span>
        )}

        {!slim && (
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px]">
            <span className={cn("inline-flex shrink-0 items-center gap-1 font-mono", face.textClass)}>
              <Dot tone={face.tone} pulse={face.pulse} title={t(face.titleKey)} />
              {t(face.labelKey)}
            </span>
            {showPersistedStatus && s.status ? (
              <span className="shrink-0 font-mono text-ink-faint">{s.status}</span>
            ) : null}
            {model !== null && (
              <span title={s.model ?? undefined} className="min-w-0 truncate font-mono text-ink-faint">
                {model}
              </span>
            )}
            {planMode && (
              <Chip tone="iris" title={t("hud.mode.planDescription")}>
                {t("sidebar.session.planChip")}
              </Chip>
            )}
            {impl && <Chip title={implementsNote ?? undefined}>{t("sidebar.session.implChip")}</Chip>}
            {orphanSource !== null && (
              <span className="shrink-0 text-ink-faint">{t("sidebar.session.sourceUnavailable")}</span>
            )}
            {handoff?.hasDescendants ? (
              <span className="shrink-0 text-ink-faint">{t("sidebar.session.planSource")}</span>
            ) : null}
            {prChip}
            {snoozedLabel !== null ? (
              <span className="shrink-0 text-ink-faint">{snoozedLabel}</span>
            ) : null}
            {scheduleLabel !== null ? <span className="shrink-0 text-ink-faint">{scheduleLabel}</span> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {clockMark}
              {pinMark}
              {lockMark}
              {voiceMark}
            </span>
          </span>
        )}

        {quote !== null && (
          <span
            title={quote.text}
            className="mt-1.5 line-clamp-2 break-words border-l-2 border-iris-dim/60 pl-2 text-[11px] leading-snug text-ink-mid"
          >
            <span className="mr-1 font-mono text-[10px] uppercase text-iris">
              {t(quote.kind === "plan" ? "sidebar.session.quotePlan" : "sidebar.session.quoteQuestion")}
            </span>
            {quote.text}
          </span>
        )}
      </button>

      {/* Hover actions (issue #938): at rest the cluster is invisible AND
          pointer-events-none, so an unseen trash button never catches a click
          aimed at the title or age. Keyboard focus still reaches it. */}
      <div className="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 rounded-md border border-line bg-raised p-0.5 opacity-0 transition-opacity duration-150 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        {source !== null && (
          <IconButton
            label={t("sidebar.session.openPlanning")}
            onClick={() => void openSession(source.tabId)}
          >
            <IconPlan />
          </IconButton>
        )}
        {firstPr !== undefined && (
          <IconButton
            label={t("pullRequest.chip.openNamed", { number: firstPr.number, state: t(pullRequestFace(firstPr).labelKey) })}
            onClick={() => openPullRequest(firstPr)}
          >
            <IconPullRequest />
          </IconButton>
        )}
        {settleable && (
          <IconButton label={t("sidebar.session.settle")} onClick={() => void settleSessions([s.tabId])}>
            <IconSettle />
          </IconButton>
        )}
        {!missing && s.live === "live" ? (
          <IconButton
            label={t("sidebar.session.stopResumable")}
            tone="copper"
            onClick={() => void terminate(s.tabId)}
          >
            <IconPower />
          </IconButton>
        ) : !missing && exited !== undefined ? (
          <Button
            size="xs"
            tone="signal"
            variant="outline"
            onClick={() => void resumeDead(s.tabId)}
            title={t("sidebar.session.resumeTitle", { title: s.title })}
          >
            {t("sidebar.session.resume")}
          </Button>
        ) : null}
        {/* Seance consult (issue #885): a read-only question about this saved
            session. Never on a live row — a running session is consulted via
            the /seance line, not by resurrecting its transcript behind it. */}
        {!missing && s.live !== "live" && s.sessionId !== null ? (
          <IconButton
            label={
              seanceAvailable
                ? t("sidebar.session.seance")
                : t("sidebar.session.seanceNeedsOmp", { version: SEANCE_MIN_OMP })
            }
            disabled={!seanceAvailable}
            onClick={() => void consultFromRow(s.tabId)}
          >
            <IconSeance />
          </IconButton>
        ) : null}
        <IconButton
          label={
            s.live === "live"
              ? t("sidebar.session.stopDelete")
              : missing
                ? t("sidebar.session.deleteRecord")
                : t("sidebar.session.deleteFiles")
          }
          tone="rose"
          onClick={() => void deleteSession(s.tabId)}
        >
          <IconTrash />
        </IconButton>
      </div>
    </div>
  );
}
