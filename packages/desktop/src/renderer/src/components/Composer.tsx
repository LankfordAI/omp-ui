import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { PLAN_COMMAND } from "@omp-ui/core/plan";
import { CAPABILITIES_COMMAND } from "@omp-ui/core/capabilities";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { currentLocaleId, useT } from "../lib/i18n";
import { useCompactShell } from "../lib/responsive";
import {
  keywordColors,
  keywordPalette,
  magicKeywordSegments,
  SHIMMER_PERIOD_MS,
} from "../lib/magic-keywords";
import { deriveDirs, detectAtQuery, insertMention, mentionRanges } from "../lib/mentions";
import { queueChipView } from "../lib/queue-chip";
import type { PromptRoute, SlashCommandInfo } from "../lib/rpc-types";
import { findRecord, sessionCwd, useStore } from "../store";
import { useDismissal } from "../lib/use-dismissal";
import { useImageDraft } from "../lib/use-image-draft";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip } from "./BranchChip";
import { ComposerActions } from "./ComposerActions";
import { ComposerSheet } from "./ComposerSheet";
import { MentionPalette, type MentionPaletteHandle } from "./MentionPalette";
import { ModelSelector } from "./ModelSelector";
import { BuildPlanControl } from "./BuildPlanControl";
import { SlashPalette, type SlashPaletteHandle } from "./SlashPalette";
import type { WorkspaceSelection } from "./WorktreeBranchFields";
import { AttachmentButton, Button, Capsule, CAPSULE_SEGMENT, Chip, IconButton, IconClose, IconTune, Label, PerimeterGlow, PerimeterSweep } from "./ui";

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
}) {
  const t = useT();
  // The palette's UI-authored descriptions must refresh with the locale, and
  // a memo keyed on `commands` alone would hold them stale across a switch.
  const localeId = currentLocaleId();
  const status = useStore((s) => s.rpc[tabId]?.status);
  const busy = useStore((s) => s.rpc[tabId]?.busy ?? false);
  const commands = useStore((s) => s.rpc[tabId]?.commands ?? NO_COMMANDS);
  // UI_PLAN_COMMAND is the palette's one canonical plan entry: omp's own
  // `plan` is TUI-only (ADR-0007) and the extension's `omp-ui-plan` is the
  // driver the intercept rewrites to, so both are filtered out.
  const paletteCommands = useMemo(
    () => [
      // omp-ui's own entries get their palette copy from the catalog (issue #363).
      { ...UI_NEW_COMMAND, description: t("composer.slash.new") },
      { ...UI_PLAN_COMMAND, description: t("composer.slash.plan") },
      ...commands.filter(
        // The capabilities bridge is UI-owned: omp advertises its hidden
        // arming command, the palette must not offer it (issue #374).
        (c) =>
          c.name !== "new" &&
          c.name !== "plan" &&
          c.name !== PLAN_COMMAND &&
          c.name !== CAPABILITIES_COMMAND,
      ),
    ],
    [commands, localeId, t],
  );
  const queued = useStore((s) => s.rpc[tabId]?.session.queuedMessageCount ?? 0);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const dead = useStore((s) => s.exited[tabId] !== undefined);
  const currentModel = useStore((s) => s.rpc[tabId]?.model ?? null);
  const compact = useCompactShell();
  const compactSurface = useStore((s) => s.compactSurface);
  const showCompactSurface = useStore((s) => s.showCompactSurface);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  const cwd = useStore((s) => sessionCwd(findRecord(s.state, tabId)));
  // A session running in a worktree cannot be pointed at a second one: the
  // branch chip's worktree section is never offered to it. Finishing the
  // worktree moves it back to the project checkout instead (issue #334).
  const hasWorktree = useStore((s) => findRecord(s.state, tabId)?.worktree != null);
  // The worktree section of the branch chip (issue #227) stands in for the
  // standalone workspace chip: offered only while the session is unprompted
  // and has no worktree of its own.
  const offerWorkspace = unprompted && !hasWorktree && cwd !== undefined;

  // The merge-back offer (issue #322): the session's own worktree branch and
  // recorded base, plus the project checkout the merge runs in. Absent for
  // plain sessions and for worktree records without a recorded base.
  const record = useStore((s) => findRecord(s.state, tabId));
  const mergeBack =
    record?.worktree != null && record.worktree.base !== null
      ? {
          branch: record.worktree.branch,
          base: record.worktree.base,
          projectRootCwd: record.projectCwd,
          tabId,
        }
      : undefined;

  const sendPrompt = useStore((s) => s.sendPrompt);
  const abortAgent = useStore((s) => s.abortAgent);
  const abortAndPrompt = useStore((s) => s.abortAndPrompt);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const convertSessionToWorktree = useStore((s) => s.convertSessionToWorktree);

  const [text, setText] = useState("");
  /**
   * The `/command` whose palette the user dismissed. Scoped to the word, not a
   * bare boolean: Escape on `/todo` must not keep the palette shut when the
   * user then clears the line and types `/compact`.
   */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  /**
   * The `@`-word whose palette the user dismissed, keyed `${start}:${query}` —
   * the same per-word dismissal contract as `dismissedFor`.
   */
  const [mentionDismissedFor, setMentionDismissedFor] = useState<string | null>(null);
  /** Caret offset in the draft; tracked so the @-word under it can be found. */
  const [caret, setCaret] = useState(0);
  /**
   * The session's working-tree file listing for the @ picker, fetched on each
   * afterwards so a picked mention paints resolved immediately.
   */
  const [files, setFiles] = useState<{ list: string[]; truncated: boolean } | null>(null);
  const [effortMenu, setEffortMenu] = useState(false);
  const { images, pasteError, onPaste, pickImages, dropImage, clearImages, dismissError } = useImageDraft();
  /** Whether the box has focus — omp shimmers a keyword only while it does. */
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
  const imagePicker = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLDivElement | null>(null);
  const palette = useRef<SlashPaletteHandle | null>(null);
  const mentionPalette = useRef<MentionPaletteHandle | null>(null);
  const effortAnchor = useRef<HTMLSpanElement | null>(null);
  /** The highlight layer under the (transparent-text) textarea. */
  const mirror = useRef<HTMLDivElement | null>(null);
  /** Sent messages, newest last. */
  const history = useRef<string[]>([]);
  /** Index into `history` while walking it; null when not recalling. */
  const recall = useRef<number | null>(null);

  const running = status === "running";
  const relaunching = status === "starting";
  const unavailable = dead || relaunching;
  const queueChip = queueChipView(running, queued);
  const trimmed = text.trim();
  const isSlash = trimmed.startsWith("/");
  const commandWord = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : null;
  const paletteOpen = !unavailable && commandWord !== null && commandWord !== dismissedFor;
  // The mention palette is suppressed on slash-command lines: a leading `/`
  // means the draft is a command, never a prompt, and commands take no files.
  // The two palettes are mutually exclusive by that construction.
  const atQuery = isSlash ? null : detectAtQuery(text, caret);
  const mentionKey = atQuery === null ? null : `${atQuery.start}:${atQuery.query}`;
  const mentionOpen = !unavailable && mentionKey !== null && mentionKey !== mentionDismissedFor;
  /**
   * omp reports vision support as `model.input` containing "image". A model
   * without it would silently drop the blocks, so the affordance says so
   * instead of failing quietly.
   */
  const vision = useStore((s) => s.rpc[tabId]?.model?.input?.includes("image") ?? true);

  /**
   * omp's magic keywords ("orchestrate" and friends) each append a hidden
   * notice that steers the turn, and the gradient is the only sign the word did
   * anything — so the composer paints them exactly as omp's own editor does.
   */
  const segments = useMemo(() => magicKeywordSegments(text), [text]);
  /** First armed keyword in the draft; its palette runs the border ring. */
  const glowKeyword = useMemo(
    () => segments.find((s) => s.keyword !== null)?.keyword ?? null,
    [segments],
  );
  const glowing = glowKeyword !== null;
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
  const runs = useMemo(() => {
    const mentions = mentionRanges(text, known);
    const out: { text: string; color?: string; iris?: boolean }[] = [];
    let base = 0;
    let mi = 0;
    for (const seg of segments) {
      if (seg.keyword !== null) {
        keywordColors(seg.keyword, phase).forEach((color, c) =>
          out.push({ text: seg.text[c]!, color }),
        );
      } else {
        const segStart = base;
        const segEnd = base + seg.text.length;
        while (mi < mentions.length && mentions[mi]!.to <= segStart) mi++;
        let pos = 0;
        for (let k = mi; k < mentions.length && mentions[k]!.from < segEnd; k++) {
          const from = Math.max(mentions[k]!.from, segStart) - segStart;
          const to = Math.min(mentions[k]!.to, segEnd) - segStart;
          if (from > pos) out.push({ text: seg.text.slice(pos, from) });
          out.push({ text: seg.text.slice(from, to), iris: true });
          pos = to;
        }
        if (pos < seg.text.length) out.push({ text: seg.text.slice(pos) });
      }
      base += seg.text.length;
    }
    return out;
  }, [segments, phase, text, known]);

  // The listing is refetched on every open so files created mid-session
  // appear; the previous list stays on screen while the new one is in flight.
  useEffect(() => {
    if (!mentionOpen || cwd === undefined) return;
    let alive = true;
    void backend
      .listProjectFiles(cwd)
      .then((result) => {
        if (alive) setFiles({ list: result.files, truncated: result.truncated });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mentionOpen, cwd]);

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

  // The shimmer runs only while focused with a keyword on screen, matching omp's
  // editor; everything else shows the static phase-0 palette.
  useEffect(() => {
    if (!focused || !glowing) {
      setPhase(0);
      return;
    }
    // A continuous colour cycle is exactly what reduced-motion asks us not to run.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase(0);
      return;
    }
    // rAF, not setInterval: the sweep advances a uniform delta per displayed
    // frame (the 70 ms interval stepped visibly — issue #204), and pauses for
    // free while the window is hidden.
    let raf = 0;
    const tick = () => {
      setPhase((Date.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [focused, glowing]);

  // A dead or relaunching tab has no stable agent to configure.
  useEffect(() => {
    if (unavailable) setEffortMenu(false);
  }, [unavailable]);
  useEffect(() => {
    if (unavailable && compactSurface === "composer-options") closeCompactSurface();
  }, [unavailable, compactSurface, closeCompactSurface]);
  useDismissal({
    open: effortMenu,
    refs: effortAnchor,
    onClose: () => setEffortMenu(false),
  });

  useDismissal({
    open: paletteOpen || mentionOpen,
    refs: composer,
    onClose: () => {
      setDismissedFor(commandWord);
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
    async (route: PromptRoute | "interrupt") => {
      let message = text.trim();
      let payload = images;
      // An image with no words is a legitimate prompt ("what is this?"), so
      // emptiness is judged on the whole draft, not the text alone.
      if ((message === "" && payload.length === 0) || unavailable || converting) return;
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
      recall.current = null;
      setText("");
      clearImages();
      setDismissedFor(null);
      setMentionDismissedFor(null);

      // A leading "/" is a command, never a prompt — even mid-run. Commands take
      // no images, so any attached here would be silently dropped by omp;
      // holding them back would be worse, since the draft is already cleared.
      if (message.startsWith("/")) {
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
          const resolved = await backend.resolveFileMentions(cwd, message);
          message += resolved.contextText;
          payload = [...payload, ...resolved.images];
        } catch {
          // A resolver failure must never block a send — ship the draft verbatim.
        }
      }

      if (route === "interrupt") {
        void abortAndPrompt(tabId, message, payload);
      } else {
        void sendPrompt(tabId, message, route, payload);
      }
      box.current?.focus({ preventScroll: true });
    },
    [
      text,
      images,
      unavailable,
      tabId,
      cwd,
      runSlashCommand,
      abortAndPrompt,
      sendPrompt,
      onPrompt,
      unprompted,
      workspace,
      converting,
      runWorktreeConversion,
    ],
  );


  /** Applies a palette pick: run it now, or complete the line for its argument. */
  const pick = useCallback(
    (name: string, takesArgument: boolean) => {
      if (takesArgument) {
        setText(`/${name} `);
        // The line is already the pick; re-listing it would just cover the box.
        setDismissedFor(name.split(/\s/, 1)[0]);
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The palettes get first refusal on navigation keys while one is open.
    if (paletteOpen && palette.current?.handleKey(e) === true) return;
    if (mentionOpen && mentionPalette.current?.handleKey(e) === true) return;

    if (e.key === "Escape") {
      // Escape only means something when there is a turn to stop; otherwise it
      // belongs to whatever else is listening.
      if (!running) return;
      e.preventDefault();
      void abortAgent(tabId);
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

  const placeholder = dead
    ? t("composer.placeholder.exited")
    : relaunching
      ? t("composer.placeholder.restarting")
      : running
        ? t("composer.placeholder.running")
        : t("composer.placeholder.idle");

  // An image alone is sendable: "what is this?" is in the picture, not the text.
  const canSend = (trimmed !== "" || images.length > 0) && !unavailable && !converting;
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

      <div className={cn("relative", !compact && "mx-auto w-full max-w-3xl")}>
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
        {paletteOpen && (
          <SlashPalette
            ref={palette}
            commands={paletteCommands}
            query={text.slice(1)}
            onClose={() => setDismissedFor(commandWord)}
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
              : "ambient plane-lit rounded-xl shadow-float " +
                "focus-within:ring-1 focus-within:ring-iris-dim/35",
            isSlash && "focus-within:border-iris-dim",
            unavailable && "opacity-50",
          )}
        >
          {/* The border-level echo of the keyword shimmer: the armed keyword's own
              14-stop gradient circling the box, phase-locked to the character paint.
              Static (phase 0) while unfocused or under reduced motion — the shimmer
              clock already enforces both. */}
          {glowKeyword !== null && (
            <PerimeterGlow colors={keywordPalette(glowKeyword)} phase={phase} />
          )}
          {(compact ? busy : busy || running) && (
            <PerimeterSweep tone={running ? "copper" : "signal"} />
          )}
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
              {/* pre-wrap swallows a trailing newline; the textarea keeps its
                  empty last line, so the mirror needs one too. */}
              {text.endsWith("\n") && "\u200b"}
            </div>
            <textarea
              ref={box}
              data-composer-input
              rows={1}
              value={text}
              disabled={unavailable}
              placeholder={placeholder}
              // The misspelling underline paints in the textarea layer even
              // over transparent glyphs; the mirror's identical metrics keep
              // it aligned with the visible text.
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
                recall.current = null;
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
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
            <Capsule className="min-w-0 shrink">
              <ModelSelector tabId={tabId} disabled={unavailable} />

              <span ref={effortAnchor} className="relative flex">
                <button
                  type="button"
                  disabled={unavailable}
                  title={
                    efforts.length > 0
                      ? t("composer.thinking.title", { efforts: efforts.join(", ") })
                      : t("composer.thinking.level")
                  }
                  onClick={() => {
                    if (efforts.length > 0) setEffortMenu((m) => !m);
                  }}
                  className={cn(
                    CAPSULE_SEGMENT,
                    "shrink-0 rounded-r-[5px] font-mono text-[11px] tabular-nums text-iris",
                  )}
                >
                  {thinkingLevel ?? t("composer.thinking.fallback")}
                </button>
                {effortMenu && (
                  <div className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                    <span className="px-1.5 pb-1 pt-0.5">
                      <Label>{t("composer.thinking.label")}</Label>
                    </span>
                    {efforts.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        disabled={unavailable}
                        onClick={() => {
                          setEffortMenu(false);
                          void setThinkingLevel(tabId, effort);
                        }}
                        className={cn(
                          "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                          effort === thinkingLevel ? "text-iris" : "text-ink-mid",
                        )}
                      >
                        {effort}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            </Capsule>

            <AdvisorControl tabId={tabId} disabled={unavailable} />

            <BuildPlanControl
              tabId={tabId}
              disabled={unavailable}
              onSelected={() => box.current?.focus({ preventScroll: true })}
            />

            <BranchChip
              projectCwd={cwd}
              workspace={offerWorkspace ? workspace : undefined}
              onWorkspaceChange={offerWorkspace ? handleWorkspaceChange : undefined}
              workspaceDisabled={unavailable || converting}
              onCreateWorktree={offerWorkspace ? createWorktreeNow : undefined}
              mergeBack={mergeBack}
            />

            <AttachmentButton disabled={unavailable} label={t("common.button.attachImages")} onClick={() => imagePicker.current?.click()} />


            {queueChip && (
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

            <span className="flex-1" />

            {text.length > COUNTER_AT && (
              <span className="shrink-0 whitespace-nowrap font-mono tabular-nums text-ink-faint">
                {text.length}c · {lines}l
              </span>
            )}

            <ComposerActions
              layout="desktop"
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
              <AttachmentButton compact disabled={unavailable} label={t("common.button.attachImages")} onClick={() => imagePicker.current?.click()} />
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
                running={running}
                isSlash={isSlash}
                canSend={canSend}
                onSubmit={(route) => void submit(route)}
                onAbort={() => void abortAgent(tabId)}
              />
            </div>
          )}
          <input
            ref={imagePicker}
            type="file"
            accept="image/*"
            multiple
            disabled={unavailable}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => void pickImages(event)}
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

        {/* The worktree-conversion status lives here, not in the branch chip's
            popover (issue #227): the conversion runs on send, when the popover
            is closed, and its failure must stay visible with the draft intact. */}
        {(converting || workspaceError !== null) && (
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
        canSend={canSend}
        onSubmit={(route) => void submit(route)}
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

/** Stable empties keep the per-field selectors from firing on every store tick. */
const NO_COMMANDS: never[] = [];
const NO_EFFORTS: never[] = [];
const NO_FILES: never[] = [];
