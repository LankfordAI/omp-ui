import type { MouseEvent as ReactMouseEvent } from "react";
import { relativeTime } from "../lib/format";
import type { SessionSummary } from "@omp-ui/core/types";
import { parseTitleCard } from "@omp-ui/core/title-card";
import { useT, type MessageKey } from "../lib/i18n";
import { cn } from "../lib/cn";
import { deriveSidebarSessionState, useStore, type SidebarSessionState } from "../store";
import { SEANCE_MIN_OMP, supportsSeance } from "../lib/seance";
import { Button, Dot, IconButton, IconLock, IconSpeaker, type Tone } from "./ui";
import type { SessionHandoff } from "../lib/session-handoffs";
import type { LivePhase } from "@omp-ui/core/live-voice";

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
const LIVE_PHASE_TITLE: Record<LivePhase, MessageKey> = {
  connecting: "composer.live.phaseConnecting",
  listening: "composer.live.phaseListening",
  working: "composer.live.phaseWorking",
  speaking: "composer.live.phaseSpeaking",
  muted: "composer.live.phaseMuted",
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
}) {
  const t = useT();
  const openSession = useStore((st) => st.openSession);
  const deleteSession = useStore((st) => st.deleteSession);
  const terminate = useStore((st) => st.terminate);
  const resumeDead = useStore((st) => st.resumeDead);
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
  // not the snapshot, so 10 Hz `live_levels` patches never re-render the
  // row; `ended` swaps the phase glyph for the runtime badge mirror —
  // results waiting outranks merely-ready, and a tab with no live voice at
  // all (no key) stays bare.
  const liveBadge = useStore((st): LivePhase | "armed" | "pending" | null => {
    if (s.mode !== "rpc-ui") return null;
    const live = st.rpc[s.tabId]?.live;
    if (live !== undefined && live !== null && !live.ended) return live.phase;
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

  return (
    <div
      onContextMenu={onContextMenu}
      className={cn(
        "group/row animate-slide-in relative flex items-center rounded-md",
        "transition-colors duration-150",
        selected ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-signal"
        />
      )}

      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        title={
          missing && !strandedSettle ? t("sidebar.session.missingHint") : implementsNote !== null ? `${s.title} — ${implementsNote}` : s.title
        }
        onClick={() => {
          if (missing && !strandedSettle) return;
          void openSession(s.tabId);
          onActivate?.();
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left",
          missing && !strandedSettle && "cursor-default",
        )}
      >
        <Dot tone={face.tone} pulse={face.pulse} title={t(face.titleKey)} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs transition-colors duration-150",
              missing ? "text-ink-faint" : "text-ink-mid group-hover/row:text-ink",
              selected && !missing && "text-ink",
            )}
          >
            {card === null ? (
              s.title
            ) : (
              <span className="flex min-w-0 items-baseline gap-1.5">
                {card.icon !== null && (
                  <span aria-hidden className="shrink-0">
                    {card.icon}
                  </span>
                )}
                <span className="shrink-0 rounded bg-raised px-1 font-mono text-[10px] tracking-wide text-ink-mid">
                  {card.code}
                </span>
                <span className="min-w-0 truncate">{card.title}</span>
              </span>
            )}
          </span>
          <span
            title={absoluteTime(s.cachedModified)}
            className="block truncate font-mono text-[10px] text-ink-faint tabular-nums"
          >
            <span className={face.textClass}>{t(face.labelKey)}</span>
            {projectLabel ? ` · ${projectLabel}` : ""}
            {when ? ` · ${when}` : ""}
            {showPersistedStatus && s.status ? ` · ${s.status}` : ""}
            {s.worktree ? (
              <span title={s.worktree.path}>{` · ⎇ ${s.worktree.branch}`}</span>
            ) : null}
            {s.snoozed === true ? ` · ${t("sidebar.session.snoozed")}` : ""}
            {/* Machine chip (#903): a bare `<Chip mono>` from ui/controls would
             *  break this block/truncate span's ellipsis, so it mirrors the
             *  worktree fragment's inline nested-span style instead. */}
            {instanceNickname ? (
              <span title={t("sidebar.session.machine", { machine: instanceNickname })}>
                {` · ${instanceNickname}`}
              </span>
            ) : null}
            {source !== null
              ? ` · ${t("sidebar.session.implementation")}`
              : orphanSource !== null
                ? ` · ${t("sidebar.session.implementation")} · ${t("sidebar.session.sourceUnavailable")}`
                : ""}
            {handoff?.hasDescendants ? ` · ${t("sidebar.session.planSource")}` : ""}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        {s.private ? (
          <span
            role="img"
            aria-label={t("session.badge.private")}
            title={t("session.badge.private")}
            className="shrink-0 self-center text-ink-faint"
          >
            <IconLock />
          </span>
        ) : null}
        {liveBadge !== null ? (
          <span
            role="img"
            aria-label={
              liveBadge === "armed"
                ? t("sidebar.session.liveVoiceArmed")
                : liveBadge === "pending"
                  ? t("sidebar.session.liveVoicePending")
                  : t("sidebar.session.liveVoice", { phase: t(LIVE_PHASE_TITLE[liveBadge]) })
            }
            title={
              liveBadge === "armed"
                ? t("sidebar.session.liveVoiceArmed")
                : liveBadge === "pending"
                  ? t("sidebar.session.liveVoicePending")
                  : t("sidebar.session.liveVoice", { phase: t(LIVE_PHASE_TITLE[liveBadge]) })
            }
            className={cn(
              "shrink-0 self-center",
              liveBadge === "speaking" || liveBadge === "pending"
                ? "text-signal"
                : liveBadge === "error"
                  ? "text-rose"
                  : liveBadge === "muted" || liveBadge === "armed"
                    ? "text-ink-faint"
                    : "text-ink-mid",
            )}
          >
            <IconSpeaker waves={liveBadge === "speaking" ? 2 : 1} />
          </span>
        ) : null}
        {source !== null && (
          <IconButton
            label={t("sidebar.session.openPlanning")}
            onClick={() => void openSession(source.tabId)}
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            <IconPlan />
          </IconButton>
        )}
        {!missing && s.live === "live" ? (
          <IconButton
            label={t("sidebar.session.stopResumable")}
            tone="copper"
            onClick={() => void terminate(s.tabId)}
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
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
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
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
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
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
          className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <IconTrash />
        </IconButton>
      </div>
    </div>
  );
}
