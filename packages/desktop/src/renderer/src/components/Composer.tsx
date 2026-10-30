import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { PLAN_COMMAND } from "@omp-ui/core/plan";
import { CAPABILITIES_COMMAND } from "@omp-ui/core/capabilities";
import { AUTORESEARCH_COMMAND } from "@omp-ui/core/autoresearch";
import { VIBE_COMMAND } from "@omp-ui/core/vibe";
import { ASYNC_JOBS_COMMAND } from "@omp-ui/core/async-jobs";
import { SESSION_SPEND_COMMAND } from "@omp-ui/core/session-spend";
import { SIDE_COMMANDS_COMMAND } from "@omp-ui/core/side-commands";
import { backend, backendFor, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { currentLocaleId, localeTag, useT, type MessageKey } from "../lib/i18n";
import { useCompactShell } from "../lib/responsive";
import { keywordPalette, SHIMMER_PERIOD_MS } from "../lib/keyword-colors";
import { MAGIC_KEYWORDS, magicKeywordSegments, type MagicKeyword } from "@omp-ui/core/magic-keywords";
import { firingKeywords } from "../lib/magic-keyword-gate";
import { deriveDirs, detectAtQuery, insertMention } from "../lib/mentions";
import { composerPaintRuns } from "../lib/composer-paint";
import type { DocumentRef } from "../lib/document-context";
import { queueChipCount, queueChipView } from "../lib/queue-chip";
import type { PromptRoute, SlashCommandInfo } from "../lib/rpc-types";
import { slashCompletion } from "../lib/slash-completion";
import { findInstance, findOwner, isChatTab, sessionCwd, useStore } from "../store";
import { useDismissal } from "../lib/use-dismissal";
import { useImageDraft } from "../lib/use-image-draft";
import { stashDraft, takeStashedDraft, useDraftStash } from "../lib/draft-stash";
import { isTypingTarget, useHotkeys } from "../lib/hotkeys";
import { STASH_HOTKEY, StashPalette, type StashPaletteHandle } from "./StashPalette";
import { AnnotationChips } from "./AnnotationChips";
import { useWordGhost } from "../lib/use-word-ghost";
import { ComposerActions } from "./ComposerActions";
import { ComposerOptions } from "./ComposerOptions";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { ComposerSheet } from "./ComposerSheet";
import { answerPendingQuestion, freeTextTarget } from "./ExtensionDialogHost";
import { MentionPalette, type MentionPaletteHandle } from "./MentionPalette";
import { LiveVoiceControl } from "./LiveVoiceControl";
import { LiveVoiceStrip } from "./LiveVoiceStrip";
import type { CheckoutEntry } from "../lib/repository-members";
import { SlashPalette, type SlashPaletteHandle } from "./SlashPalette";
import type { WorkspaceSelection } from "./WorktreeBranchFields";
import { QueuedMessageList } from "./QueuedMessageList";
import { AttachmentButton, Button, Chevron, Chip, IconButton, IconClose, IconTune, Label, PerimeterGlow, PerimeterSweep } from "./ui";
import { DictationControl, DictationStrip } from "./ComposerDictation";
import { useDictation } from "../lib/use-dictation";
import { useDictationHotkey } from "../lib/use-dictation-hotkey";
import { NATIVE_LIVE_MIN_OMP, supportsNativeLive } from "../lib/live-voice";
import { canOpenLivePeer } from "../lib/live-peer";
import { sendAtResetMs } from "../lib/send-at-reset";
import { startVisibleInterval } from "../lib/visible-interval";
import { formatSnoozeUntil } from "../lib/snooze-until";
import { nextMintedWorktreeBranch, worktreeBranchPrefix } from "@omp-ui/core/worktree-branch";

/** How often the composer re-reads the clock while it offers Send at reset. */
const SEND_AT_RESET_TICK_MS = 30_000;

/** The composer's submit routes: omp's prompt routes, interrupt, and Send at reset (#986). */
export type SubmitRoute = PromptRoute | "interrupt" | "at-reset";

/**
 * The composer. Everything the user can *say* to a live agent lives here:
 * prompt, steer, queue a follow-up, abort, and interrupt-and-replace — omp
 * exposes all five and the old single-line input reached only the first.
 */

/** Beyond this the textarea scrolls instead of growing. */
const MAX_ROWS = 12;
/** A counter below this is noise; above it the user is writing something long. */
const COUNTER_AT = 400;


export function Composer({
  tabId,
  onPrompt,
  unprompted = false,
  liveVoiceVisible = true,
  onDictationActiveChange,
}: {
  tabId: string;
  /** Fires when a non-slash draft is submitted on any route — the first one docks the hero. */
  onPrompt?: () => void;
  /**
   * True only while the session sits at its empty-transcript hero (issues
   * #225, #227): the branch chip's worktree section is offered, and the first
   * send may convert the session to a worktree before the prompt goes out.
   */
  unprompted?: boolean;
  /** Review owns the live controls while the composer draft stays mounted. */
  liveVoiceVisible?: boolean;
  onDictationActiveChange?: (active: boolean) => void;
}) {
  const t = useT();
  // The palette's UI-authored descriptions must refresh with the locale, and
  // a memo keyed on `commands` alone would hold them stale across a switch.
  const localeId = currentLocaleId();
  const status = useStore((s) => s.rpc[tabId]?.status);
  const composerQueue = useStore((s) => s.rpc[tabId]?.composerQueue);
  const drainComposerQueue = useStore((s) => s.drainComposerQueue);
  const busy = useStore((s) => s.rpc[tabId]?.busy ?? false);
  const activeTurnKeywords = useStore((s) => s.rpc[tabId]?.activeTurnKeywords ?? NO_KEYWORDS);
  const commands = useStore((s) => s.rpc[tabId]?.commands ?? NO_COMMANDS);
  const experimentsEnabled = useStore((s) => s.state?.experimentsEnabled === true);
  // A chat has no plan mode and no project for autoresearch to key on (#894).
  const chat = useStore((s) => isChatTab(s.state, tabId));
  // UI_PLAN_COMMAND is the palette's one canonical plan entry: omp's own
  // `plan` is TUI-only (ADR-0007) and the extension's `omp-ui-plan` is the
  // driver the intercept rewrites to, so both are filtered out.
  // The goal family is UI-owned the same way (issue #381, ADR-0046): the
  // composer intercepts it and drives omp's native goal command, so omp's own
  // advertised `goal` can never produce a second row for the same action.
  const paletteCommands = useMemo(() => {
    const uiEntries: SlashCommandInfo[] = [
      // omp-ui's own entries get their palette copy from the catalog (issue #363).
      { ...UI_NEW_COMMAND, description: t("composer.slash.new") },
      ...(chat ? [] : [{ ...UI_PLAN_COMMAND, description: t("composer.slash.plan") }]),
      {
        ...UI_GOAL_COMMAND,
        description: t("composer.slash.goal"),
        subcommands: UI_GOAL_SUBCOMMANDS.map((sub) => ({
          name: sub.name,
          ...(sub.usage === undefined ? {} : { usage: sub.usage }),
          description: t(sub.key),
        })),
      },
      { ...UI_GUIDED_GOAL_COMMAND, description: t("composer.slash.guidedGoal") },
      { ...UI_BTW_COMMAND, description: t("composer.slash.btw") },
      { ...UI_SEANCE_COMMAND, description: t("composer.slash.seance") },
      {
        ...UI_VIBE_COMMAND,
        description: t("composer.slash.vibe"),
        subcommands: UI_VIBE_SUBCOMMANDS.map((sub) => ({
          name: sub.name,
          ...(sub.usage === undefined ? {} : { usage: sub.usage }),
          description: t(sub.key),
        })),
      },
      ...(experimentsEnabled && !chat
        ? [
            {
              ...UI_AUTORESEARCH_COMMAND,
              description: t("composer.slash.autoresearch"),
              subcommands: UI_AUTORESEARCH_SUBCOMMANDS.map((sub) => ({
                name: sub.name,
                description: t(sub.key),
              })),
            },
          ]
        : []),
    ];
    const owned = new Set(uiEntries.map((entry) => entry.name));
    return [
      ...uiEntries,
      ...commands.filter(
        // The capabilities bridge is UI-owned: omp advertises its hidden
        // arming command, the palette must not offer it (issue #374).
        (c) =>
          c.name !== "new" &&
          c.name !== "plan" &&
          c.name !== PLAN_COMMAND &&
          c.name !== CAPABILITIES_COMMAND &&
          c.name !== VIBE_COMMAND &&
          c.name !== AUTORESEARCH_COMMAND &&
          c.name !== ASYNC_JOBS_COMMAND &&
          c.name !== SESSION_SPEND_COMMAND &&
          c.name !== SIDE_COMMANDS_COMMAND &&
          !owned.has(c.name),
      ),
    ];
  }, [chat, commands, experimentsEnabled, localeId, t]);
  const queued = useStore((s) => {
    const session = s.rpc[tabId]?.session;
    return session ? queueChipCount(session) : 0;
  });
  // Only a runtime that reports omp's queue text gets a listable chip.
  const queueListed = useStore((s) => s.rpc[tabId]?.session.queuedMessages != null);
  const owner = useStore((s) => findOwner(s.state, tabId));
  const record = owner?.record;
  const dead = record?.live !== "live";
  const currentModel = useStore((s) => s.rpc[tabId]?.model ?? null);
  // #932: booted without its pinned model; main refuses prompts until a pick.
  const modelHold = useStore((s) => findOwner(s.state, tabId)?.record.modelHold ?? null);
  // Send at reset (issue #986): the provider's next reset while the session is
  // limited. Ticks so a passed reset withdraws the offer.
  const [resetNow, setResetNow] = useState(() => Date.now());
  const resetAtMs = useStore((s) => sendAtResetMs(s.rpc[tabId], resetNow));
  useEffect(() => {
    if (resetAtMs === null) return;
    return startVisibleInterval(() => setResetNow(Date.now()), SEND_AT_RESET_TICK_MS);
  }, [resetAtMs]);
  // A native session only: a terminal tab has no prompt channel main may inject into.
  const holdsPrompts = record?.mode === "rpc-ui";
  // Live voice gates on the omp version (issue #778): 18.14.0 added the
  // `live_connect` verb (ADR-0071), unknown version hides the feature. It also
  // gates on this client carrying the call's peer (issue #968): the peer runs
  // in whichever renderer starts the call — desktop, remote web client, or a
  // joined remote-instance tab — and a non-secure origin has no microphone.
  const liveSupported = useStore(
    (s) => supportsNativeLive(s.rpc[tabId]?.capabilities?.ompVersion ?? null) && canOpenLivePeer(),
  );
  // The version gate alone, so the mic's title can name the required omp
  // when old-harness omp — not a missing microphone — is why live voice is absent.
  const liveGateBlocked = useStore((s) => {
    const v = s.rpc[tabId]?.capabilities?.ompVersion ?? null;
    return v !== null && !supportsNativeLive(v);
  });
  // Live voice holds the microphone (omp records audio itself): dictation's
  // getUserMedia would fail anyway, so the mic gives up its slot while a live
  // session runs and push-to-talk `r` is suppressed (issue #805). The
  // disabled-with-title mic only reappears in the transient case where the
  // capabilities snapshot drops out mid-live-session and the gate flips.
  const liveActive = useStore((s) => {
    const live = s.rpc[tabId]?.live;
    return live !== null && live !== undefined && !live.ended;
  });
  const compact = useCompactShell();
  const compactSurface = useStore((s) => s.compactSurface);
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const cwd = sessionCwd(record);
  // The owning remote instance (issue #416): project-scoped reads go to that
  // host, and while it is not joined the composer is as inert as a dead tab —
  // nothing typed here could reach the agent.
  const instanceId = owner?.instanceId ?? null;
  const instanceDown = useStore(
    (s) => instanceId !== null && findInstance(s.state, instanceId)?.status !== "joined",
  );
  // A session running in a worktree cannot be pointed at a second one: the
  // branch chip's worktree section is never offered to it. Finishing the
  // worktree moves it back to the project checkout instead (issue #334).
  const hasWorktree = record?.worktree != null;
  // The worktree section of the branch chip (issue #227) stands in for the
  // standalone workspace chip: offered only while the session is unprompted
  // and has no worktree of its own.
  const offerWorkspace = unprompted && !hasWorktree && cwd !== undefined;

  // The finish-worktree offer (issues #385–#389): this tab for any worktree
  // session — a null base no longer withholds it, the dialog falls back to
  // the default branch. Undefined for plain sessions and the sheet instance.
  const finishTabId = record?.worktree != null ? tabId : undefined;

  const sendPrompt = useStore((s) => s.sendPrompt);
  const holdPrompt = useStore((s) => s.holdPrompt);
  const abortAgent = useStore((s) => s.abortAgent);
  const abortAndPrompt = useStore((s) => s.abortAndPrompt);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const runShellCommand = useStore((s) => s.runShellCommand);
  const convertSessionToWorktree = useStore((s) => s.convertSessionToWorktree);
  const moveUnpromptedSession = useStore((s) => s.moveUnpromptedSession);
  const launchSession = useStore((s) => s.launchSession);
  const planOn = useStore((s) => s.rpc[tabId]?.plan?.enabled === true);

  const [text, setText] = useState("");
  /**
   * The slash draft (text after `/`) whose palette the user dismissed. Scoped
   * to the exact draft, not a bare boolean or the word: Escape on `/todo` must
   * not keep the palette shut when the user then types `/todo ` and its
   * subcommands become the offer, nor when the line is cleared and `/compact`
   * typed.
   */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  /**
   * The `@`-word whose palette the user dismissed, keyed `${start}:${query}` —
   * the same per-word dismissal contract as `dismissedFor`.
   */
  const [mentionDismissedFor, setMentionDismissedFor] = useState<string | null>(null);
  /** Caret offset in the draft; tracked so the @-word under it can be found. */
  const [caret, setCaret] = useState(0);
  /** Whether the selection is collapsed — ghost completion needs a bare caret (#715). */
  const [collapsed, setCollapsed] = useState(true);
  /**
   * The session's working-tree file listing for the @ picker, fetched on each
   * afterwards so a picked mention paints resolved immediately.
   */
  const [files, setFiles] = useState<{ list: string[]; truncated: boolean } | null>(null);
  const [queueMenu, setQueueMenu] = useState(false);
  /** The draft stash picker (issue #989); shown only over an empty draft. */
  const [stashOpen, setStashOpen] = useState(false);
  /** A stash is reading documents back and persisting; a second chord waits. */
  const stashing = useRef(false);
  const stashed = useDraftStash();
  const {
    images,
    documents,
    annotations,
    pasteError,
    onPaste,
    pickFiles,
    addImages,
    addDocuments,
    addAnnotations,
    dropImage,
    dropDocument,
    dropAnnotation,
    clearDraft,
    setPasteError,
    dismissError,
  } = useImageDraft();
  /** Draft characters shimmer only while the box has focus. */
  const [focused, setFocused] = useState(false);
  /**
   * Where this session's first prompt will run (issues #225, #227), chosen
   * via the worktree section of the branch chip, offered only while the
   * session is unprompted.
   */
  const [workspace, setWorkspace] = useState<WorkspaceSelection>({ mode: "checkout" });
  /** The last worktree-conversion failure, rendered in the composer's inline strip. */
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  /** True while the first send is converting the session to a worktree. */
  const [converting, setConverting] = useState(false);
  /** The machine chip's target name while the session moves there (#936). */
  const [moving, setMoving] = useState<string | null>(null);
  // The machine chip (#936): an unprompted, project-checkout session with
  // nothing materialized can be re-homed onto another checkout's machine.
  const offerMachine = unprompted && !chat && !hasWorktree && record?.sessionId === null;

  const moveToMember = async (member: CheckoutEntry): Promise<void> => {
    setMoving(
      member.instanceId === null
        ? t("quickopen.host.local")
        : (findInstance(useStore.getState().state, member.instanceId)?.nickname ?? member.instanceId),
    );
    const next = await moveUnpromptedSession(tabId, member, { text, images, documents, annotations });
    // Success unmounts this composer with its tab; a failure keeps the draft.
    if (next === null) setMoving(null);
  };

  const handleWorkspaceChange = (
    next: WorkspaceSelection | ((prev: WorkspaceSelection) => WorkspaceSelection),
  ): void => {
    setWorkspace(next);
    // A stale git error must never outlive the selection it names — the next
    // attempt renders its own failure.
    setWorkspaceError(null);
  };
  /** Gradient rotation ∈ [0,1); 0 is the static palette. */
  const [phase, setPhase] = useState(0);

  const box = useRef<HTMLTextAreaElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLDivElement | null>(null);
  const palette = useRef<SlashPaletteHandle | null>(null);
  const mentionPalette = useRef<MentionPaletteHandle | null>(null);
  const stashPalette = useRef<StashPaletteHandle | null>(null);
  const queueAnchor = useRef<HTMLSpanElement | null>(null);
  const queueTrigger = useRef<HTMLButtonElement | null>(null);
  /** The highlight layer under the (transparent-text) textarea. */
  const mirror = useRef<HTMLDivElement | null>(null);
  /** Sent messages, newest last. */
  const history = useRef<string[]>([]);
  /** Index into `history` while walking it; null when not recalling. */
  const recall = useRef<number | null>(null);

  const running = status === "running";
  const relaunching = status === "starting";
  const unavailable = dead || relaunching || instanceDown;
  const activeKeywordEffect = running && !unavailable && activeTurnKeywords.length > 0;
  const activeKeywordPalette = useMemo(() => {
    const keywords = MAGIC_KEYWORDS.filter((keyword) => activeTurnKeywords.includes(keyword.word));
    if (keywords.length === 1) return keywordPalette(keywords[0]!.word);
    return keywords.flatMap((keyword) => keywordPalette(keyword.word));
  }, [activeTurnKeywords]);
  const queueChip = queueChipView(running, queued);
  // The popover closes with its chip; a later queue starts closed.
  const queueVisible = queueChip !== null;
  useEffect(() => {
    if (!queueVisible) setQueueMenu(false);
  }, [queueVisible]);
  const trimmed = text.trim();
  const isSlash = trimmed.startsWith("/");
  /** What the slash palette can offer for this draft; null mounts none (lib/slash-completion.ts). */
  const completion = useMemo(() => slashCompletion(text, paletteCommands), [text, paletteCommands]);
  /** The exact slash draft a dismissal applies to — `dismissedFor` compares against it. */
  const paletteKey = text.startsWith("/") ? text.slice(1) : null;
  const paletteOpen = !unavailable && completion !== null && paletteKey !== dismissedFor;
  // The mention palette also serves slash drafts: omp's file-mentions
  // extractor runs on the raw text of anything that reaches the prompt
  // path — unadvertised slash lines verbatim, and arguments a command
  // re-injects as a prompt (e.g. /goal set) — so an @-word in a command
  // argument resolves just like one in prose. It still never triggers
  // inside the command word itself: detectAtQuery requires the `@` to
  // lead its word, and `/@x` has no boundary before it.
  const atQuery = detectAtQuery(text, caret);
  const mentionKey = atQuery === null ? null : `${atQuery.start}:${atQuery.query}`;
  const mentionOpen = !unavailable && mentionKey !== null && mentionKey !== mentionDismissedFor;
  // omp's ghost-text word completion (issue #715): prose at the end of the
  // draft only; the palettes own Tab while open. A slash draft is asked about
  // with its command word elided, and a shell command draft is never prose
  // (wordGhostCandidate).
  const wordGhost = useWordGhost({
    tabId,
    text,
    caret,
    active: focused && collapsed && !unavailable && !converting && !paletteOpen && !mentionOpen,
  });
  /**
   * omp reports vision support as `model.input` containing "image". A model
   * without it would silently drop the blocks, so the affordance says so
   * instead of failing quietly.
   */
  const vision = useStore((s) => s.rpc[tabId]?.model?.input?.includes("image") ?? true);

  /**
   * omp's magic keywords ("orchestrate" and friends) each append a hidden
   * notice that steers the turn, and the gradient is the only sign the word did
   * anything. The glow means omp will actually attach that notice: the word
   * matches omp's matcher AND its `magicKeywords.*` settings are on AND the
   * session has every tool it requires — stricter than omp's own editor, which
   * checks only the master setting. The gate comes from the capabilities
   * bridge; until a snapshot lands, every known keyword paints.
   */
  const capabilities = useStore((s) => s.rpc[tabId]?.capabilities ?? null);
  const firing = useMemo(() => firingKeywords(capabilities), [capabilities]);
  const segments = useMemo(() => magicKeywordSegments(text, firing), [text, firing]);
  /** First armed keyword in the draft; its palette runs the idle border ring. */
  const glowKeyword = useMemo(
    () => segments.find((s) => s.keyword !== null)?.keyword ?? null,
    [segments],
  );
  const glowing = glowKeyword !== null;
  const draftPhase = focused ? phase : 0;
  const animateKeywords = activeKeywordEffect || (focused && glowing);
  const borderPalette = activeKeywordEffect
    ? activeKeywordPalette
    : !running && glowKeyword !== null
      ? keywordPalette(glowKeyword)
      : null;
  /** Resolved-as-of-now paths: the file listing plus every ancestor dir. */
  const known = useMemo(() => {
    const list = files?.list ?? [];
    return new Set([...list, ...deriveDirs(list)]);
  }, [files]);
  /**
   * Painted runs: one span per keyword character, and prose split at resolved
   * @mentions. A resolved mention paints iris — the composer's interactive
   * accent — because omp will fire it at send time; an unpainted @ stays
   * ordinary prose, which is exactly what omp will do with it.
   */
  const runs = useMemo(
    () => composerPaintRuns(text, known, draftPhase, firing),
    [text, known, draftPhase, firing],
  );

  // The listing is refetched on every open so files created mid-session
  // appear; the previous list stays on screen while the new one is in flight.
  useEffect(() => {
    if (!mentionOpen || cwd === undefined) return;
    let alive = true;
    void backendFor(instanceId)
      .listProjectFiles(cwd)
      .then((result) => {
        if (alive) setFiles({ list: result.files, truncated: result.truncated });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mentionOpen, cwd, instanceId]);

  // Grow to fit, then scroll. Height must be released before measuring, or
  // `scrollHeight` reports the previous, larger box and never shrinks back.
  const fit = useCallback(() => {
    const el = box.current;
    if (el === null) return;
    el.style.height = "auto";
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 20;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // `scrollHeight` covers content + padding; `height` under border-box also
    // owes the border, which is exactly what offset/client differ by.
    const border = el.offsetHeight - el.clientHeight;
    const wanted = el.scrollHeight + border;
    const desktopMax = line * MAX_ROWS + padding + border;
    const max = compact ? Math.min(desktopMax, (window.visualViewport?.height ?? window.innerHeight) * 0.35) : desktopMax;
    const scrollable = wanted > max;
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = scrollable ? "auto" : "hidden";
    // The instrument scrollbar (style.css ::-webkit-scrollbar, 10px classic on
    // Linux) shrinks the box's content width when it appears, but not the
    // mirror's — past the first divergent wrap the underline, caret, and
    // selection drift off the visible glyphs (issue #282). Narrow the mirror
    // to the box's live width; reading clientWidth after the overflowY change
    // forces the reflow, so the scrollbar is already accounted for.
    if (mirror.current !== null) {
      mirror.current.style.width =
        scrollable && el.clientWidth > 0 ? `${el.clientWidth}px` : "";
      // Resizing fires no scroll event, so the mirror has to be told.
      mirror.current.scrollTop = el.scrollTop;
    }
  }, [compact]);

  useLayoutEffect(() => fit(), [text, fit]);

  // A width change re-wraps the draft without touching `text` — window
  // resize, zoom, the inspector rail's pane — and a fit measured for the old
  // wrap clips the new one with overflow locked hidden: no scrollbar, no
  // wheel. Observe the box directly (the TerminalTab/ShellDrawer pattern);
  // the width check skips the height-only echo of our own fit, and a hidden
  // (display:none) tab reports 0 until it resurfaces — which is itself a
  // refit trigger, so a composer mounted hidden fits itself on first reveal.
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  // The composer lands focused on a fresh session and whenever boot or an
  // advisor relaunch clears `unavailable`. Overlay teardown owns the separate
  // focus handoff when a new active tab was opened beneath it.
  useEffect(() => {
    const el = box.current;
    if (el !== null && !unavailable && document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
  }, [unavailable]);

  // One clock drives the focused draft and the authoritative active-turn ring.
  // Active work keeps moving without focus; draft paint stays at phase 0 then.
  useEffect(() => {
    if (!animateKeywords) {
      setPhase(0);
      return;
    }
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // rAF, not setInterval: the sweep advances a uniform delta per displayed
    // frame (the 70 ms interval stepped visibly — issue #204), and pauses for
    // free while the window is hidden.
    let raf: number | undefined;
    const tick = () => {
      setPhase((Date.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS);
      raf = requestAnimationFrame(tick);
    };
    const updateMotion = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      if (motion.matches) setPhase(0);
      else tick();
    };
    motion.addEventListener("change", updateMotion);
    updateMotion();
    return () => {
      motion.removeEventListener("change", updateMotion);
      if (raf !== undefined) cancelAnimationFrame(raf);
    };
  }, [animateKeywords]);

  useEffect(() => {
    if (unavailable && compactSurface === "composer-options") closeCompactSurface();
  }, [unavailable, compactSurface, closeCompactSurface]);
  // The browser pane's hand-back (issue #519): its screenshot joins the image
  // draft and its URL the text, drained once so a re-render cannot add them
  // twice. The transcript's Comment action (issue #983) and every restore
  // path queue annotation chips the same way. Only this composer reads the
  // queue — PlanReview's draft never does.
  useEffect(() => {
    if (composerQueue === undefined) return;
    const queued = drainComposerQueue(tabId);
    if (queued === null) return;
    addImages(queued.images);
    addDocuments(queued.documents ?? []);
    addAnnotations(queued.annotations ?? []);
    const lines = queued.text.join("\n");
    if (lines !== "") setText((prev) => (prev === "" ? lines : `${prev}\n${lines}`));
    box.current?.focus({ preventScroll: true });
  }, [composerQueue, tabId, drainComposerQueue, addImages, addDocuments, addAnnotations]);
  useDismissal({
    open: queueMenu,
    refs: queueAnchor,
    onClose: () => setQueueMenu(false),
    onEscape: () => setQueueMenu(false),
    restoreFocus: () => queueTrigger.current?.focus(),
  });

  useDismissal({ open: stashOpen, refs: composer, onClose: () => setStashOpen(false) });
  useDismissal({
    open: paletteOpen || mentionOpen,
    refs: composer,
    onClose: () => {
      setDismissedFor(paletteKey);
      setMentionDismissedFor(mentionKey);
    },
  });

  /**
   * Cuts the pending worktree — on the first send (issue #225) or from the
   * branch chip's create button (issue #314): one shared conversion, one error
   * surface. Returns success so the send path can gate the prompt and the
   * chip's popover can close.
   */
  const runWorktreeConversion = useCallback(
    async (selection: Extract<WorkspaceSelection, { mode: "worktree" }>): Promise<boolean> => {
      if (converting) return false;
      setConverting(true);
      setWorkspaceError(null);
      try {
        await convertSessionToWorktree(tabId, {
          branch: selection.branch,
          baseRef: selection.baseRef,
          baseBranch: selection.baseBranch,
        });
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
        setConverting(false);
        return false;
      }
      setConverting(false);
      // The record's new worktree hides the chip via its selector; reset the
      // selection anyway so a stale "worktree" can never gate a send.
      setWorkspace({ mode: "checkout" });
      return true;
    },
    [converting, tabId, convertSessionToWorktree],
  );

  /** The branch chip's create-now action: the same conversion, no prompt. */
  const createWorktreeNow = useCallback((): Promise<boolean> => {
    if (workspace.mode !== "worktree") return Promise.resolve(false);
    return runWorktreeConversion(workspace);
  }, [workspace, runWorktreeConversion]);

  const submit = useCallback(
    async (route: SubmitRoute) => {
      const draftText = text.trim();
      let message = draftText;
      let payload = images;
      let docRefs: DocumentRef[] = [];
      // An image, PDF, or annotation with no words is a legitimate prompt
      // ("what is this?"), so emptiness is judged on the whole draft.
      if (
        (message === "" && payload.length === 0 && documents.length === 0 && annotations.length === 0) ||
        unavailable ||
        converting ||
        moving !== null
      )
        return;
      // #932: a held session starts no turn; the notice says why, and the
      // draft stays. Slash and bash commands still go out.
      if (modelHold !== null && !message.startsWith("/") && !message.startsWith("!")) return;
      // Send at reset (issue #986) holds a prompt, never a command; the owning
      // host keeps it, so a refusal returns before the draft clears.
      const atReset = route === "at-reset";
      if (atReset && (resetAtMs === null || message.startsWith("/") || message.startsWith("!"))) return;
      // A leading "!" is omp's bash command, dispatched concurrently over
      // rpc-ui with no model turn (issue #678). Like slash, it takes no
      // images and gets no @-resolution; the draft goes out verbatim. It
      // is never a dialog answer, never a worktree conversion, never a
      // prompt — so the draft is committed here, before those paths run.
      if (message.startsWith("!")) {
        // Consecutive duplicates make ↑ recall useless.
        if (history.current[history.current.length - 1] !== message) {
          history.current.push(message);
        }
        recall.current = null;
        setText("");
        clearDraft();
        // Annotations only ride prompts (ADR-0077): a command keeps them.
        addAnnotations(annotations);
        setDismissedFor(null);
        setMentionDismissedFor(null);
        if (message.length > 1) {
          void runShellCommand(tabId, message.slice(1).trimStart());
          box.current?.focus({ preventScroll: true });
        }
        return;
      }
      // While a free-text-capable question heads the tab's extension
      // queue, this box *is* the card's Other field (issue #421): Enter
      // answers it instead of prompting. A leading "/" stays a command and
      // interrupt keeps its abort-and-prompt route. The handler consults
      // the store at call time, so a frame that vanished between render
      // and Enter answers nothing and falls through to the prompt path —
      // exactly what the second Enter of a double-tap on a loop frame
      // does until the editor frame lands. On "kept-draft" the draft (and
      // the tray) stay put for that editor frame; an answer is not a
      // prompt, so no history push, no hero dismissal, no conversion.
      if (!compact && route !== "interrupt" && !atReset && !message.startsWith("/")) {
        const outcome = answerPendingQuestion(tabId, message);
        if (outcome !== "not-answerable") {
          if (outcome === "answered") {
            setText("");
            clearDraft();
            // A dialog answer is not a prompt: annotation chips stay for the next one.
            addAnnotations(annotations);
          }
          box.current?.focus({ preventScroll: true });
          return;
        }
      }
      // A first prompt with the branch chip's worktree section set to a fresh
      // worktree converts the session before anything else happens (issue
      // #225) — the same conversion the chip's create button runs (issue #314):
      // on failure the draft, the hero, and the chip all stay put, and git's
      // message renders in the composer's inline strip. Slash commands are
      // not prompts — they bypass the conversion entirely.
      if (!message.startsWith("/") && workspace.mode === "worktree" && unprompted) {
        if (!(await runWorktreeConversion(workspace))) return;
      }
      if (!message.startsWith("/")) onPrompt?.();
      // Consecutive duplicates make ↑ recall useless.
      if (message !== "" && history.current[history.current.length - 1] !== message) {
        history.current.push(message);
      }
      // Materialize the PDFs on the machine that owns the session *before*
      // the draft is committed (ADR-0044): a rejection returns with text,
      // images, and documents intact — the keep-draft shape of the worktree
      // conversion. This must live here, not the slice: the send calls below
      // are fire-and-forget and could never restore a cleared draft.
      if (!message.startsWith("/") && documents.length > 0) {
        try {
          const paths = await backend.attachDocument(tabId, documents);
          docRefs = documents.map((document, i) => ({
            name: document.name,
            path: paths[i]!,
          }));
        } catch (err) {
          setPasteError(displayMessage(err));
          return;
        }
      }
      if (atReset) {
        if (!(await holdPrompt(tabId, message, resetAtMs!, payload, docRefs, annotations))) return;
      }
      recall.current = null;
      setText("");
      clearDraft();
      setDismissedFor(null);
      setMentionDismissedFor(null);

      // A leading "/" is a command, never a prompt — even mid-run. Commands take
      // no images, so any attached here would be silently dropped by omp;
      // holding them back would be worse, since the draft is already cleared.
      // Annotation chips stay: they are the next prompt's (ADR-0077).
      if (message.startsWith("/")) {
        addAnnotations(annotations);
        void runSlashCommand(tabId, message);
        box.current?.focus({ preventScroll: true });
        return;
      }

      // omp only extracts @mentions on the idle prompt path; steer/follow_up
      // queue verbatim, so omp-ui resolves and inlines the contents itself on
      // those routes. Idle and interrupt (abort_and_prompt re-enters idle)
      // rely on omp's native resolution — no double-inclusion is possible.
      const busyRoute = route === "steer" || route === "follow_up";
      if (busyRoute && cwd !== undefined && message.includes("@")) {
        try {
          const resolved = await backendFor(instanceId).resolveFileMentions(cwd, message);
          message += resolved.contextText;
          payload = [...payload, ...resolved.images];
        } catch {
          // A resolver failure must never block a send — ship the draft verbatim.
        }
      }

      box.current?.focus({ preventScroll: true });
      // A held prompt is main's from here; the transcript's pending card shows it.
      if (atReset) return;
      const accepted =
        route === "interrupt"
          ? await abortAndPrompt(tabId, message, payload, docRefs, annotations)
          : await sendPrompt(tabId, message, route, payload, docRefs, annotations);
      if (!accepted) {
        // Refused or rejected (runCommand already reported why): the draft
        // comes back — the send-in-background keep-draft shape — unless the
        // user has started a new one in the meantime.
        setText((current) => (current === "" ? draftText : current));
        addImages(images);
        addDocuments(documents);
        addAnnotations(annotations);
      }
    },
    [
      text,
      images,
      documents,
      annotations,
      addImages,
      addDocuments,
      addAnnotations,
      setPasteError,
      unavailable,
      compact,
      tabId,
      cwd,
      instanceId,
      runSlashCommand,
      runShellCommand,
      abortAndPrompt,
      sendPrompt,
      onPrompt,
      unprompted,
      workspace,
      converting,
      moving,
      runWorktreeConversion,
      modelHold,
      resetAtMs,
      holdPrompt,
    ],
  );

  /**
   * Send in background (issue #982): from the fresh-session hero, the draft
   * starts a NEW session — this hero's project, machine, privacy, mode, and
   * workspace choice — without leaving this tab. The draft clears and the
   * box keeps focus for the next ask; this session stays unprompted. Prompts
   * only: a slash or shell line is this session's own command.
   */
  const sendInBackground = useCallback(async (): Promise<void> => {
    const message = text.trim();
    if (
      !unprompted ||
      chat ||
      record === undefined ||
      (message === "" && images.length === 0 && documents.length === 0 && annotations.length === 0) ||
      message.startsWith("/") ||
      message.startsWith("!") ||
      unavailable ||
      converting ||
      moving !== null
    )
      return;
    const draft = { text, images, documents, annotations };
    const worktree =
      workspace.mode === "worktree"
        ? { mint: { branch: workspace.branch, baseRef: workspace.baseRef, baseBranch: workspace.baseBranch } }
        : null;
    if (message !== "" && history.current[history.current.length - 1] !== message) history.current.push(message);
    recall.current = null;
    setText("");
    clearDraft();
    setDismissedFor(null);
    setMentionDismissedFor(null);
    box.current?.focus({ preventScroll: true });
    let landed: string | null = null;
    try {
      landed = await launchSession(record.projectCwd, {
        instanceId,
        prompt: draft.text,
        images: draft.images,
        documents: draft.documents,
        annotations: draft.annotations,
        planMode: planOn,
        worktree,
        background: true,
        private: record.private,
      });
    } catch (err) {
      // A worktree spawn throws git's stderr: the composer's inline strip owns it.
      setWorkspaceError(err instanceof Error ? err.message : String(err));
    }
    if (landed === null) {
      // Never landed (already reported) or refused: the draft comes back.
      setText((current) => (current === "" ? draft.text : current));
      addImages(draft.images);
      addDocuments(draft.documents);
      addAnnotations(draft.annotations);
      return;
    }
    // The minted branch is checked out now: the next background ask needs its own.
    if (workspace.mode === "worktree") {
      setWorkspace((current) =>
        current.mode !== "worktree"
          ? current
          : {
              ...current,
              branch: nextMintedWorktreeBranch(current.branch, worktreeBranchPrefix(record.projectCwd)),
              // A base this launch created exists now: the next one cuts from it.
              ...(current.baseBranch !== null && current.baseBranch.trim() !== ""
                ? { baseRef: current.baseBranch.trim(), baseBranch: null, baseTouched: true }
                : {}),
            },
      );
    }
  }, [
    text,
    images,
    documents,
    annotations,
    unprompted,
    chat,
    record,
    unavailable,
    converting,
    moving,
    workspace,
    instanceId,
    planOn,
    launchSession,
    clearDraft,
    addImages,
    addDocuments,
    addAnnotations,
  ]);

  /** Applies a palette pick: run it now, or complete the line for what follows. */
  const pick = useCallback(
    (name: string, takesArgument: boolean) => {
      if (takesArgument) {
        setText(`/${name} `);
        // Completing never dismisses: a command with subcommands opens its
        // second stage, and anything else has nothing left to list — the
        // completion hides the palette on its own.
        setDismissedFor(null);
        box.current?.focus({ preventScroll: true });
        return;
      }
      setText("");
      setDismissedFor(null);
      void runSlashCommand(tabId, `/${name}`);
      box.current?.focus({ preventScroll: true });
    },
    [tabId, runSlashCommand],
  );

  /** Applies an @-palette pick: swap the @-word for the mention, caret after it. */
  const pickMention = useCallback(
    (relPath: string) => {
      if (atQuery === null) return;
      const next = insertMention(text, atQuery.start, caret, relPath);
      setText(next.text);
      setCaret(next.caret);
      setMentionDismissedFor(null);
      // The DOM caret lags the state write by a commit; restore it explicitly.
      requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret));
      box.current?.focus({ preventScroll: true });
    },
    [text, caret, atQuery],
  );

  /** Splices one dictated phrase at the caret like pickMention does — joined
   *  against non-space neighbours, never submitted, never focusing (issue
   *  #647, #746). A transcript landing while a slash palette is open just
   *  edits the draft. */
  const insertAtCaret = useCallback((spoken: string) => {
    const el = box.current;
    const draft = el?.value ?? text;
    const at = el?.selectionStart ?? caret;
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    const lead = before !== "" && !/\s$/.test(before) ? " " : "";
    const trail = after !== "" && !/^\s/.test(after) ? " " : "";
    const caretNext = at + lead.length + spoken.length;
    // Phrases can land back to back with no render between; a synchronous
    // commit makes the next insert read this one's draft and caret.
    flushSync(() => {
      setText(before + lead + spoken + trail + after);
      setCaret(caretNext);
    });
    el?.setSelectionRange(caretNext, caretNext);
  }, [text, caret]);

  /** The `+` menu's draft triggers (issue #939): spliced at the caret like a
   *  dictated phrase, then the draft takes focus so the palette opens. */
  const insertTrigger = (trigger: "/" | "@" | "!"): void => {
    // A palette the user dismissed for an earlier draft must not stay shut for this one.
    setDismissedFor(null);
    setMentionDismissedFor(null);
    insertAtCaret(trigger);
    box.current?.focus({ preventScroll: true });
  };

  const draftEmpty = text === "" && images.length === 0 && documents.length === 0 && annotations.length === 0;
  useEffect(() => {
    if (!draftEmpty || unavailable) setStashOpen(false);
  }, [draftEmpty, unavailable]);

  /**
   * Draft stash (issue #989): a draft moves into the app-wide stash and the
   * composer clears; an empty composer opens the picker instead. A path-only
   * document (rewind prefill, restored queue entry) is read back on its host
   * first, so the stashed draft owns its bytes. The draft clears before the
   * write lands and comes back if it fails — the send-refused keep-draft shape.
   */
  const stashOrPick = async (): Promise<void> => {
    if (unavailable || moving !== null || converting || stashing.current) return;
    if (draftEmpty) {
      setStashOpen((open) => !open);
      box.current?.focus({ preventScroll: true });
      return;
    }
    stashing.current = true;
    const draft = { text, images, documents, annotations };
    recall.current = null;
    setText("");
    clearDraft();
    setDismissedFor(null);
    setMentionDismissedFor(null);
    try {
      const owned = await Promise.all(
        draft.documents.map(async (document) =>
          document.data !== undefined || document.path === undefined
            ? document
            : { type: document.type, name: document.name, mimeType: document.mimeType, data: await backend.readDocument(tabId, document.path) },
        ),
      );
      await stashDraft({ ...draft, documents: owned });
    } catch (err) {
      setText((current) => (current === "" ? draft.text : current));
      addImages(draft.images);
      addDocuments(draft.documents);
      addAnnotations(draft.annotations);
      setPasteError(t("composer.stash.failed", { reason: displayMessage(err) }));
    } finally {
      stashing.current = false;
      box.current?.focus({ preventScroll: true });
    }
  };

  /** Moves a stashed draft into this composer; its documents re-materialize on this tab's host at send. */
  const applyStashed = async (id: string): Promise<void> => {
    setStashOpen(false);
    const draft = await takeStashedDraft(id).catch(() => null);
    box.current?.focus({ preventScroll: true });
    if (draft === null) return;
    addImages(draft.images);
    addDocuments(draft.documents);
    addAnnotations(draft.annotations);
    if (draft.text !== "") setText((prev) => (prev === "" ? draft.text : `${prev}\n${draft.text}`));
  };

  // While the plan review owns the column the composer is hidden (liveVoiceVisible
  // false): the chord must not stash a draft the user cannot see.
  const activeHere = useStore((s) => s.activeTabId === tabId) && liveVoiceVisible;
  const stashKey = (e: globalThis.KeyboardEvent): void => {
    // Another text field keeps the chord: only the composer's own box or a
    // non-editable focus stashes this tab's draft.
    if (isTypingTarget(e.target) && e.target !== box.current) return;
    e.preventDefault();
    void stashOrPick();
  };
  // macOS reports Option+S as `ß` in `e.key`; both spellings are the chord.
  useHotkeys(activeHere ? { [STASH_HOTKEY]: stashKey, "mod+alt+ß": stashKey } : {});

  /** A drained take hands the caret back to the draft. */
  const focusDraft = useCallback(() => box.current?.focus({ preventScroll: true }), []);

  const voice = useDictation({ insert: insertAtCaret, focus: focusDraft });
  useDictationHotkey(tabId, voice, liveActive);
  const dictationActive = voice.phase === "recording" || voice.phase === "requesting";
  useEffect(() => {
    onDictationActiveChange?.(dictationActive);
  }, [dictationActive, onDictationActiveChange]);
  useEffect(() => () => onDictationActiveChange?.(false), [onDictationActiveChange]);
  /** Commits a draft the ghost produced; the DOM caret lags the state write by a commit. */
  const applyGhostDraft = (next: { text: string; caret: number }): void => {
    setText(next.text);
    setCaret(next.caret);
    recall.current = null;
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The palettes get first refusal on navigation keys while one is open.
    if (paletteOpen && palette.current?.handleKey(e) === true) return;
    if (mentionOpen && mentionPalette.current?.handleKey(e) === true) return;
    if (stashOpen && stashPalette.current?.handleKey(e) === true) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing;
    if (plain && e.key.length === 1) {
      const absorbed = wordGhost.takeProvisionalKey(e.key);
      if (absorbed !== null) {
        e.preventDefault();
        applyGhostDraft(absorbed);
        return;
      }
    }
    if (plain && !e.shiftKey && (e.key === "Tab" || e.key === "ArrowRight")) {
      const accepted = wordGhost.accept(e.key === "Tab");
      if (accepted !== null) {
        e.preventDefault();
        applyGhostDraft(accepted);
        return;
      }
    }

    if (e.key === "Escape") {
      // While recording, Escape discards the take before it means anything
      // else (issue #647).
      if (voice.phase === "recording" || voice.phase === "requesting") {
        e.preventDefault();
        voice.cancel();
        return;
      }
      // Escape only means something when there is a turn to stop; otherwise it
      // belongs to whatever else is listening.
      if (!running) return;
      e.preventDefault();
      void abortAgent(tabId);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.altKey) {
      // Send in background (issue #982) — the hero's chord only; elsewhere it
      // is unbound and must not fall through to queue or interrupt.
      e.preventDefault();
      if (!e.shiftKey) void sendInBackground();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit(e.shiftKey ? "interrupt" : "follow_up");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(running ? "steer" : "prompt");
      return;
    }
    // Shell-style recall. Entry requires an empty box, so walking back past the
    // newest entry restores emptiness — there is never a draft to preserve.
    if (e.key === "ArrowUp" && (text === "" || recall.current !== null)) {
      const log = history.current;
      const at = recall.current ?? log.length;
      if (at === 0) return;
      e.preventDefault();
      recall.current = at - 1;
      setText(log[at - 1]);
      return;
    }
    if (e.key === "ArrowDown" && recall.current !== null) {
      e.preventDefault();
      const log = history.current;
      const next = recall.current + 1;
      recall.current = next >= log.length ? null : next;
      setText(next >= log.length ? "" : log[next]);
    }
  };

  // Head of the tab's pending extension dialogs — while it accepts free
  // text, this box is the question's Other field (issue #421).
  const pendingFrame = useStore((s) => s.rpc[tabId]?.extensionQueue[0]);
  const placeholder = dead
    ? t("composer.placeholder.exited")
    : relaunching
      ? t("composer.placeholder.restarting")
      : !compact && freeTextTarget(pendingFrame) !== "none"
        ? t("composer.placeholder.answer")
        : running
          ? t("composer.placeholder.running")
          : modelHold !== null
            ? t("composer.placeholder.modelHold")
            : t("composer.placeholder.idle");

  // An image or PDF alone is sendable: "what is this?" is in the attachment, not the text.
  // A held session still runs slash and bash commands (/new, !ls, …); main
  // refuses any that would start a turn.
  const canSend =
    (trimmed !== "" || images.length > 0 || documents.length > 0 || annotations.length > 0) &&
    !unavailable &&
    !converting &&
    moving === null &&
    (modelHold === null || isSlash || trimmed.startsWith("!"));
  // Send at reset (issue #986): a prompt — never a command — for a native
  // session whose provider reports a reset ahead; its label names the reset.
  const atReset =
    holdsPrompts && resetAtMs !== null && !isSlash && !trimmed.startsWith("!")
      ? { when: formatSnoozeUntil(resetAtMs, new Date(resetNow), localeTag()), canHold: canSend && modelHold === null }
      : null;
  const lines = text === "" ? 0 : text.split("\n").length;

  return (
    <div
      ref={composer}
      className={cn(
        "relative shrink-0",
        compact
          ? "ambient border-t border-line bg-sunken px-4 py-3 compact-composer"
          : "px-4 pb-3 pt-1.5",
      )}
    >

      {/* pointer-events-auto: the float above is transparent to the pointer so
          its side gutters do not swallow wheel and selection aimed at the
          transcript; the card column itself takes clicks (issue #395). */}
      <div className={cn("relative pointer-events-auto", !compact && "mx-auto w-full max-w-[var(--transcript-max)]")}>
        {stashOpen && (
          <StashPalette
            ref={stashPalette}
            drafts={stashed}
            onApply={(draft) => void applyStashed(draft.id)}
            onDelete={(draft) => void takeStashedDraft(draft.id).catch(() => {})}
            onClose={() => setStashOpen(false)}
          />
        )}
        {mentionOpen && atQuery !== null && (
          <MentionPalette
            ref={mentionPalette}
            query={atQuery.query}
            files={files?.list ?? NO_FILES}
            truncated={files?.truncated ?? false}
            onPick={pickMention}
            onClose={() => setMentionDismissedFor(mentionKey)}
          />
        )}
        {paletteOpen && completion !== null && (
          <SlashPalette
            ref={palette}
            commands={paletteCommands}
            completion={completion}
            onClose={() => setDismissedFor(paletteKey)}
            onPick={(command, subcommand) => {
              if (subcommand !== undefined) {
                // `usage` is the subcommand's own argument hint; a required one
                // (`<name>`) must be typed, an optional one (`[raw]`) can run.
                const needsArgument = subcommand.usage?.includes("<") === true;
                pick(`${command.name} ${subcommand.name}`, needsArgument);
                return;
              }
              // A hint or a subcommand tree means the command wants an argument.
              const takesArgument =
                command.input?.hint !== undefined ||
                (command.subcommands !== undefined && command.subcommands.length > 0);
              pick(command.name, takesArgument);
            }}
          />
        )}

        <div
          className={cn(
            "relative rounded-lg border border-line transition-colors",
            "focus-within:border-line-strong",
            compact
              ? "bg-raised"
              : "ambient glass-surface rounded-xl shadow-float " +
                "focus-within:ring-1 focus-within:ring-iris-dim/35",
            isSlash && "focus-within:border-iris-dim",
            unavailable && "opacity-50",
          )}
        >
          {/* Exactly one border effect: active keyword, ordinary running sweep,
              idle draft keyword, then the non-running busy signal. */}
          {borderPalette !== null ? (
            <PerimeterGlow
              colors={borderPalette}
              phase={activeKeywordEffect ? phase : draftPhase}
            />
          ) : (compact ? busy : busy || running) ? (
            <PerimeterSweep tone={running ? "copper" : "signal"} />
          ) : null}
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 pt-2 pb-1.5">
              {images.map((image, i) => (
                <span key={i} className="group/att relative">
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={t("composer.attachment.alt", { n: i + 1 })}
                    title={image.mimeType}
                    className="size-12 rounded border border-line-strong bg-sunken object-cover"
                  />
                  <span className="absolute -right-1 -top-1 opacity-0 transition-opacity group-hover/att:opacity-100 focus-within:opacity-100">
                    <IconButton
                      label={t("composer.attachment.remove", { n: i + 1 })}
                      disabled={unavailable}
                      tone="rose"
                      onClick={() => dropImage(i)}
                      className="size-4 rounded-full border border-line-strong bg-overlay"
                    >
                      <IconClose />
                    </IconButton>
                  </span>
                </span>
              ))}
              <Label className="ml-0.5">
                {images.length} {images.length === 1 ? t("composer.attachment.image") : t("composer.attachment.images")}
              </Label>
              {!vision && (
                <Chip tone="copper" title={t("composer.vision.title")}>
                  {t("composer.vision.noVision")}
                </Chip>
              )}
            </div>
          )}
          {documents.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 pt-2 pb-1.5">
              {documents.map((document, i) => (
                <Chip key={i} tone="iris" truncate title={document.path ?? document.mimeType}>
                  <span className="min-w-0 truncate">{document.name}</span>
                  <IconButton
                    label={t("composer.attachment.documentRemove", { n: i + 1 })}
                    disabled={unavailable}
                    tone="rose"
                    onClick={() => dropDocument(i)}
                    className="size-4 rounded-full border border-line-strong bg-overlay"
                  >
                    <IconClose />
                  </IconButton>
                </Chip>
              ))}
              <Label className="ml-0.5">
                {documents.length} {documents.length === 1 ? t("composer.attachment.document") : t("composer.attachment.documents")}
              </Label>
            </div>
          )}
          {annotations.length > 0 && (
            <AnnotationChips
              annotations={annotations}
              onRemove={dropAnnotation}
              disabled={unavailable}
              className="border-b border-line px-2 pt-2 pb-1.5"
            />
          )}
          {/* The mirror draws the glyphs; the textarea above it owns the caret,
              selection, and every interaction. Their box metrics must stay
              identical or the paint drifts off the text. */}
          <div className="relative">
            <div
              ref={mirror}
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 overflow-hidden",
                "whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed text-ink compact-composer-text",
                isSlash ? "font-mono" : "font-sans",
              )}
            >
              {runs.map((run, i) => (
                <span
                  key={i}
                  className={run.iris === true ? "text-iris" : undefined}
                  style={run.color === undefined ? undefined : { color: run.color }}
                >
                  {run.text}
                </span>
              ))}
              {/* omp's ghost completion (issue #715): painted only here, after
                  the last glyph. Appending it directly would fuse it with the
                  draft's last word (issue #853: "almo" + "st" lays out as
                  "almost"), and break-words then moves the fused word — the
                  user's glyphs included — to a mirror line the textarea never
                  wraps to, drifting glyphs off the caret layer and clipping
                  them. The U+200B is a break opportunity at zero width: the
                  user's word never moves; only the ghost may wrap, and the
                  mirror's overflow-hidden clips it. */}
              {wordGhost.ghost !== null && (
                <>
                  {"\u200b"}
                  <span data-word-ghost className="text-ink-faint">
                    {wordGhost.ghost.suffix}
                  </span>
                </>
              )}
              {/* pre-wrap swallows a trailing newline; the textarea keeps its
                  empty last line, so the mirror needs one too. */}
              {text.endsWith("\n") && "\u200b"}
            </div>
            <textarea
              ref={box}
              data-composer-input
              rows={1}
              value={text}
              disabled={unavailable || moving !== null}
              placeholder={placeholder}
              // The misspelling underline paints in the textarea layer even
              // over transparent glyphs; the mirror's identical metrics keep
              // it aligned with the visible text.
              spellCheck
              onChange={(e) => {
                wordGhost.noteEdit(e.target.value, e.target.selectionStart);
                setText(e.target.value);
                setCaret(e.target.selectionStart);
                setCollapsed(e.target.selectionStart === e.target.selectionEnd);
                recall.current = null;
              }}
              onSelect={(e) => {
                setCaret(e.currentTarget.selectionStart);
                setCollapsed(e.currentTarget.selectionStart === e.currentTarget.selectionEnd);
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => void onPaste(e)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onScroll={(e) => {
                // Past MAX_ROWS the box scrolls internally; the mirror follows.
                if (mirror.current !== null) mirror.current.scrollTop = e.currentTarget.scrollTop;
              }}
              className={cn(
                "relative block w-full resize-none bg-transparent px-3 py-2 outline-none!",
                "text-sm leading-relaxed placeholder:text-ink-faint compact-composer-text",
                // Transparent glyphs over the mirror; the selection tint must stay
                // translucent or it paints the highlighted text out.
                "text-transparent caret-ink selection:bg-iris-dim/40 selection:text-transparent",
                isSlash ? "font-mono" : "font-sans",
              )}
            />
          </div>

          {!compact && (
          <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[11px]">
            <ComposerPlusMenu
              tabId={tabId}
              disabled={unavailable}
              voiceRow={liveSupported ? (liveVoiceVisible ? "live" : null) : voice.supported ? "dictate" : null}
              dictateDisabled={unavailable || liveActive || voice.phase === "transcribing" || voice.phase === "requesting"}
              liveStartBlocked={voice.phase === "recording" || voice.phase === "requesting"}
              draftEmpty={text === ""}
              onAttach={() => filePicker.current?.click()}
              onDictate={voice.toggle}
              onInsert={insertTrigger}
              stash={draftEmpty ? "pick" : "stash"}
              onStash={() => void stashOrPick()}
            />
            <ComposerOptions
              tabId={tabId}
              disabled={unavailable}
              chat={chat}
              projectCwd={cwd}
              instanceId={instanceId}
              workspace={offerWorkspace ? workspace : undefined}
              onWorkspaceChange={offerWorkspace ? handleWorkspaceChange : undefined}
              workspaceDisabled={unavailable || converting}
              onCreateWorktree={offerWorkspace ? createWorktreeNow : undefined}
              finishTabId={finishTabId}
              offerMachine={offerMachine}
              machineDisabled={unavailable || converting || moving !== null}
              onPickMachine={(member) => void moveToMember(member)}
              onModeSelected={() => box.current?.focus({ preventScroll: true })}
            />
            {queueChip && !queueListed && (
              <Chip
                mono
                tone="copper"
                title={running ? t("composer.queue.queuedTitle") : t("composer.queue.parkedTitle")}
                className="min-w-0 shrink"
              >
                <span className="min-w-0 truncate">
                  {running ? t("composer.queue.queued", { n: queued }) : t("composer.queue.parked", { n: queued })}
                </span>
              </Chip>
            )}
            {queueChip && queueListed && (
              <span ref={queueAnchor} className="relative flex min-w-0 shrink">
                <button
                  ref={queueTrigger}
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={queueMenu}
                  title={running ? t("composer.queue.queuedTitle") : t("composer.queue.parkedTitle")}
                  onClick={() => setQueueMenu((open) => !open)}
                  className="flex min-w-0 rounded"
                >
                  <Chip mono tone="copper" className="min-w-0 shrink">
                    <span className="min-w-0 truncate">
                      {running ? t("composer.queue.queued", { n: queued }) : t("composer.queue.parked", { n: queued })}
                    </span>
                    <Chevron open={false} className="rotate-90 text-copper" />
                  </Chip>
                </button>
                {queueMenu && (
                  <div className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 max-h-72 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-line-strong bg-overlay p-2">
                    <QueuedMessageList tabId={tabId} disabled={unavailable} />
                  </div>
                )}
              </span>
            )}

            <span className="flex-1" />

            {text.length > COUNTER_AT && (
              <span className="shrink-0 whitespace-nowrap font-mono tabular-nums text-ink-faint">
                {text.length}c · {lines}l
              </span>
            )}

            {/* One voice affordance (issue #805): the live capsule takes the
                mic's slot on a runtime with native live voice. */}
            {liveSupported ? (liveVoiceVisible && (
              <LiveVoiceControl
                tabId={tabId}
                disabled={unavailable || voice.phase === "recording" || voice.phase === "requesting"}
              />
            )) : (
              /* Disabled buttons drop pointer events, so the title rides the
                 wrapper: reachable when the version gate drops out mid-live-session.
                 The dictation mic rides the app's own STT (no omp dependency) and
                 stays enabled; when it self-hides and the version gate holds live
                 voice back, a disabled live capsule names the required omp. */
              <span
                title={liveActive ? t("composer.live.micInUse") : liveGateBlocked ? t("composer.live.needsNewerOmp", { version: NATIVE_LIVE_MIN_OMP }) : undefined}
                className={cn("inline-flex", liveActive && "cursor-not-allowed")}
              >
                {voice.supported ? (
                  <DictationControl disabled={unavailable || liveActive} voice={voice} />
                ) : liveGateBlocked && liveVoiceVisible ? (
                  <LiveVoiceControl tabId={tabId} disabled startDisabled />
                ) : null}
              </span>
            )}

            <ComposerActions
              layout="desktop"
              atReset={atReset}
              running={running}
              isSlash={isSlash}
              canSend={canSend}
              onSubmit={(route) => void submit(route)}
              onAbort={() => void abortAgent(tabId)}
            />
          </div>
          )}
          {compact && (
            <div className="flex min-h-11 items-center gap-1.5 px-1.5 pb-1.5">
              <AttachmentButton compact disabled={unavailable} label={t("common.button.attachFiles")} onClick={() => filePicker.current?.click()} />
              {/* Same exclusive slot in the compact row (issue #805). */}
              {liveSupported ? (liveVoiceVisible && (
                <LiveVoiceControl
                  tabId={tabId}
                  disabled={unavailable || voice.phase === "recording" || voice.phase === "requesting"}
                />
              )) : (
                <span
                  title={liveActive ? t("composer.live.micInUse") : liveGateBlocked ? t("composer.live.needsNewerOmp", { version: NATIVE_LIVE_MIN_OMP }) : undefined}
                  className={cn("inline-flex", liveActive && "cursor-not-allowed")}
                >
                  {voice.supported ? (
                    <DictationControl compact disabled={unavailable || liveActive} voice={voice} />
                  ) : liveGateBlocked && liveVoiceVisible ? (
                    <LiveVoiceControl tabId={tabId} disabled startDisabled />
                  ) : null}
                </span>
              )}
              <Button
                variant="ghost"
                title={t("composer.options.title")}
                className="h-11 min-w-0 flex-1 justify-start gap-2 px-2 text-ink-mid"
                disabled={unavailable}
                onClick={() => showCompactSurface("composer-options")}
              >
                <IconTune className="size-4 shrink-0" />
                <span className="truncate font-mono text-[11px]">{currentModel?.name || currentModel?.id || t("composer.model.fallback")}</span>
                <span className="sr-only">{t("composer.options.title")}</span>
              </Button>
              {queueChip && <Chip mono tone="copper" title={running ? t("composer.queue.queuedTitle") : t("composer.queue.parkedTitle")}>{queued}</Chip>}
              <ComposerActions
                layout="compact"
                atReset={atReset}
                running={running}
                isSlash={isSlash}
                canSend={canSend}
                onSubmit={(route) => void submit(route)}
                onAbort={() => void abortAgent(tabId)}
              />
            </div>
          )}
          <input
            ref={filePicker}
            type="file"
            accept="image/*,application/pdf"
            multiple
            disabled={unavailable}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => void pickFiles(event)}
          />
        </div>

        {pasteError !== null && (
          <div className="animate-rise mt-2 flex items-start gap-2 text-[11px] text-copper">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0">
              <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeLinejoin="round" />
              <path d="M8 7v3" stroke="currentColor" strokeLinecap="round" />
            </svg>
            <span className="min-w-0 flex-1 break-words" data-selectable>
              {pasteError}
            </span>
            <IconButton label={t("composer.error.dismissPaste")} onClick={dismissError}>
              <IconClose className="size-3" />
            </IconButton>
          </div>
        )}

        {modelHold !== null && (
          <div className="animate-rise mt-2 flex items-start gap-2 text-[11px] text-copper">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0">
              <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeLinejoin="round" />
              <path d="M8 7v3" stroke="currentColor" strokeLinecap="round" />
            </svg>
            <span className="min-w-0 flex-1 break-words" data-selectable>
              {modelHold.reason === "not-found"
                ? t("composer.modelHold.notFound", { model: modelHold.model, message: modelHold.message })
                : t("composer.modelHold.notice", {
                    provider: modelHold.provider,
                    endpoint: modelHold.endpoint,
                    model: modelHold.model,
                  })}
            </span>
          </div>
        )}

        <DictationStrip voice={voice} />

        {liveVoiceVisible && <LiveVoiceStrip tabId={tabId} />}

        {/* The worktree-conversion status lives here, not in the branch chip's
            popover (issue #227): the conversion runs on send, when the popover
            is closed, and its failure must stay visible with the draft intact. */}
        {(converting || moving !== null || workspaceError !== null) && (
          <div className="animate-rise mt-2 flex items-start gap-2 text-[11px]">
            {workspaceError !== null ? (
              <>
                <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0 text-copper">
                  <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeLinejoin="round" />
                  <path d="M8 7v3" stroke="currentColor" strokeLinecap="round" />
                </svg>
                <span className="min-w-0 flex-1 break-words text-copper" data-selectable>
                  {workspaceError}
                </span>
                <IconButton label={t("composer.error.dismissWorktree")} onClick={() => setWorkspaceError(null)}>
                  <IconClose className="size-3" />
                </IconButton>
              </>
            ) : moving !== null ? (
              <span className="text-ink-faint">{t("composer.machine.moving", { machine: moving })}</span>
            ) : (
              <span className="text-ink-faint">{t("composer.strip.converting")}</span>
            )}
          </div>
        )}
      </div>
      <ComposerSheet
        open={compactSurface === "composer-options"}
        onClose={closeCompactSurface}
        tabId={tabId}
        projectCwd={cwd}
        unavailable={unavailable}
        liveVoiceVisible={liveVoiceVisible}
        canSend={canSend}
        onSubmit={(route) => void submit(route)}
        stash={draftEmpty ? "pick" : "stash"}
        onStash={() => {
          closeCompactSurface();
          void stashOrPick();
        }}
      />
    </div>
  );
}

/**
 * omp-ui's own `/new`: a new live session in a new tab — NOT omp's in-process
 * lineage switch. omp does not advertise `/new` (17.2.6), so without this entry
 * the slash palette would never show it; the store intercepts the bare command
 * before it can reach omp.
 */
const UI_NEW_COMMAND: SlashCommandInfo = {
  name: "new",
  description: "new live session in a new tab",
  source: "omp-ui",
};

/**
 * omp-ui's Build / Plan selector. omp's /plan is TUI-only (ADR-0007) and the plan
 * extension's own omp-ui-plan would be a second row for the same action,
 * so this is the palette's single plan entry; runSlashCommand intercepts it.
 */
const UI_PLAN_COMMAND: SlashCommandInfo = {
  name: "plan",
  description: "plan mode — read-only; a plan is drafted and reviewed on request",
  source: "omp-ui",
};

/**
 * omp's goal family, offered as omp-ui's own rows (issue #381). `goal` and
 * `guided-goal` reach the model as literal prose over rpc unless the composer
 * intercepts them; the intercept drives omp's native goal command (ADR-0046),
 * so omp's advertised `goal` never appears as a second row.
 */
const UI_GOAL_COMMAND: SlashCommandInfo = {
  name: "goal",
  description: "goal — one objective this session works toward on its own",
  source: "omp-ui",
  input: { hint: "[--budget N] [objective]" },
  subcommands: [],
};

/** Palette copy for each subcommand, resolved against the locale at build time. */
const UI_GOAL_SUBCOMMANDS: { name: string; usage?: string; key: MessageKey }[] = [
  { name: "set", usage: "[--budget N] <objective>", key: "composer.slash.goalSet" },
  { name: "show", key: "composer.slash.goalShow" },
  { name: "pause", key: "composer.slash.goalPause" },
  { name: "resume", key: "composer.slash.goalResume" },
  { name: "drop", key: "composer.slash.goalDrop" },
];

const UI_GUIDED_GOAL_COMMAND: SlashCommandInfo = {
  name: "guided-goal",
  description: "the agent interviews you, then sets the goal it agrees on",
  source: "omp-ui",
  input: { hint: "[rough objective]" },
};

/**
 * omp's `/btw` is TUI-only (its entry defines `handleTui` only) and absent
 * from `get_available_commands`, so the palette would never show it; the
 * store intercepts the line in native tabs and dispatches omp's native `btw`
 * command there (issue #775).
 */
const UI_BTW_COMMAND: SlashCommandInfo = {
  name: "btw",
  description: "ask a side question without touching the transcript",
  source: "omp-ui",
  input: { hint: "<question>" },
};

/**
 * omp's `/seance` is TUI-only (its entry defines `handleTui` only — there is
 * no rpc verb) and absent from `get_available_commands`, so the palette would
 * never show it; the store intercepts the line in native tabs and opens the
 * Seance consult dialog there (issue #885).
 */
const UI_SEANCE_COMMAND: SlashCommandInfo = {
  name: "seance",
  description: "consult a saved session without resuming it",
  source: "omp-ui",
  input: { hint: "[session id|path] [--model selector]" },
};

/**
 * omp's `/vibe` is TUI-only and absent from `get_available_commands`, so the
 * palette would never show it; the store intercepts the line in native tabs
 * (issue #683) and the hidden `omp-ui-vibe` driver never appears as a row.
 */
const UI_VIBE_COMMAND: SlashCommandInfo = {
  name: "vibe",
  description: "vibe mode — this session directs worker sessions of its own",
  source: "omp-ui",
  input: { hint: "[verb …]" },
  subcommands: [],
};

/** Palette copy for each vibe verb, resolved against the locale at build time. */
const UI_VIBE_SUBCOMMANDS: { name: string; usage?: string; key: MessageKey }[] = [
  { name: "on", key: "composer.slash.vibeOn" },
  { name: "off", key: "composer.slash.vibeOff" },
  { name: "spawn", usage: "[--good] [--name NAME] PROMPT", key: "composer.slash.vibeSpawn" },
  { name: "send", usage: "WORKER MESSAGE", key: "composer.slash.vibeSend" },
  { name: "wait", key: "composer.slash.vibeWait" },
  { name: "kill", usage: "WORKER", key: "composer.slash.vibeKill" },
  { name: "list", key: "composer.slash.vibeList" },
];

/**
 * omp's `/autoresearch`, offered as omp-ui's own row (ADR-0030): `start` and
 * `lab` are renderer surfaces the store intercepts, the rest reach omp verbatim.
 * omp advertises `autoresearch` itself — the owned set folds its row into this
 * one — and its hidden `omp-ui-autoresearch` arming command is filtered out
 * like the capabilities bridge's.
 */
const UI_AUTORESEARCH_COMMAND: SlashCommandInfo = {
  name: "autoresearch",
  description: "autoresearch experiments: start, lab, off, clear",
  source: "omp-ui",
  subcommands: [],
};

const UI_AUTORESEARCH_SUBCOMMANDS: { name: string; key: MessageKey }[] = [
  { name: "start", key: "composer.slash.autoresearchStart" },
  { name: "lab", key: "composer.slash.autoresearchLab" },
  { name: "off", key: "composer.slash.autoresearchOff" },
  { name: "clear", key: "composer.slash.autoresearchClear" },
];

/** Stable empties keep the per-field selectors from firing on every store tick. */
const NO_COMMANDS: never[] = [];
const NO_FILES: never[] = [];
const NO_KEYWORDS: readonly MagicKeyword[] = [];
