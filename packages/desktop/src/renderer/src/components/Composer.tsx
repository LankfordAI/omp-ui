import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type { ImageAttachment } from "@omp-ui/core/types";
import { PLAN_COMMAND } from "@omp-ui/core/plan";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import { hasClipboardImage, readClipboardImages, readImageFiles } from "../lib/clipboard-image";
import {
  keywordColors,
  magicKeywordSegments,
  SHIMMER_FRAME_MS,
  SHIMMER_PERIOD_MS,
} from "../lib/magic-keywords";
import { deriveDirs, detectAtQuery, insertMention, mentionRanges } from "../lib/mentions";
import type { PromptRoute, SlashCommandInfo } from "../lib/rpc-types";
import { findRecord, useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { BranchChip } from "./BranchChip";
import { MentionPalette, type MentionPaletteHandle } from "./MentionPalette";
import { ModelSelector } from "./ModelSelector";
import { BuildPlanControl } from "./BuildPlanControl";
import { SlashPalette, type SlashPaletteHandle } from "./SlashPalette";
import { AttachmentButton, Button, Capsule, CAPSULE_SEGMENT, Chip, IconButton, Label, ProgressSweep, Sheet } from "./ui";

/**
 * The composer. Everything the user can *say* to a live agent lives here:
 * prompt, steer, queue a follow-up, abort, and interrupt-and-replace — omp
 * exposes all five and the old single-line input reached only the first.
 */

/** Beyond this the textarea scrolls instead of growing. */
const MAX_ROWS = 12;
/** A counter below this is noise; above it the user is writing something long. */
const COUNTER_AT = 400;

/** Sliders — the compact options trigger, echoing the HUD's queue-modes icon. */
function IconTune() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" className="size-4 shrink-0">
      <path d="M2 4.5h4.6M10.4 4.5H14M2 11.5h2.6M8.4 11.5H14" />
      <circle cx="8.5" cy="4.5" r="1.7" />
      <circle cx="6.5" cy="11.5" r="1.7" />
    </svg>
  );
}

/** Arrow-up send glyph for the compact primary control. */
function IconSend() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

export function Composer({ tabId }: { tabId: string }) {
  const status = useStore((s) => s.rpc[tabId]?.status);
  const busy = useStore((s) => s.rpc[tabId]?.busy ?? false);
  const storeError = useStore((s) => s.rpc[tabId]?.error);
  const commands = useStore((s) => s.rpc[tabId]?.commands ?? NO_COMMANDS);
  // UI_PLAN_COMMAND is the palette's one canonical plan entry: omp's own
  // `plan` is TUI-only (ADR-0007) and the extension's `omp-ui-plan` is the
  // driver the intercept rewrites to, so both are filtered out.
  const paletteCommands = useMemo(
    () => [
      UI_NEW_COMMAND,
      UI_PLAN_COMMAND,
      ...commands.filter(
        (c) => c.name !== "new" && c.name !== "plan" && c.name !== PLAN_COMMAND,
      ),
    ],
    [commands],
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
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd);

  const sendPrompt = useStore((s) => s.sendPrompt);
  const abortAgent = useStore((s) => s.abortAgent);
  const abortAndPrompt = useStore((s) => s.abortAndPrompt);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);

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
   * The project's file listing for the @ picker, fetched on each open and kept
   * afterwards so a picked mention paints resolved immediately.
   */
  const [files, setFiles] = useState<{ list: string[]; truncated: boolean } | null>(null);
  const [effortMenu, setEffortMenu] = useState(false);
  /** Errors are store-owned, so dismissal remembers the message it hid. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /**
   * Image Attachments in this draft, in the order they were pasted or picked.
   * They ride the same frame as the text and are cleared with it.
   */
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** Why an Attachment was refused (over omp's 20 MB ceiling, unreadable). */
  const [pasteError, setPasteError] = useState<string | null>(null);
  /** Whether the box has focus — omp shimmers a keyword only while it does. */
  const [focused, setFocused] = useState(false);
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
  const error = storeError !== undefined && storeError !== dismissed ? storeError : null;
  const trimmed = text.trim();
  const isSlash = trimmed.startsWith("/");
  const commandWord = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : null;
  const paletteOpen = !dead && commandWord !== null && commandWord !== dismissedFor;
  // The mention palette is suppressed on slash-command lines: a leading `/`
  // means the draft is a command, never a prompt, and commands take no files.
  // The two palettes are mutually exclusive by that construction.
  const atQuery = isSlash ? null : detectAtQuery(text, caret);
  const mentionKey = atQuery === null ? null : `${atQuery.start}:${atQuery.query}`;
  const mentionOpen = !dead && mentionKey !== null && mentionKey !== mentionDismissedFor;
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
  const glowing = segments.some((s) => s.keyword !== null);
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
    if (!mentionOpen || projectCwd === undefined) return;
    let alive = true;
    void backend
      .listProjectFiles(projectCwd)
      .then((result) => {
        if (alive) setFiles({ list: result.files, truncated: result.truncated });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mentionOpen, projectCwd]);

  // Grow to fit, then scroll. Height must be released before measuring, or
  // `scrollHeight` reports the previous, larger box and never shrinks back.
  useLayoutEffect(() => {
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
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? "auto" : "hidden";
    // Resizing fires no scroll event, so the mirror has to be told.
    if (mirror.current !== null) mirror.current.scrollTop = el.scrollTop;
  }, [text, compact]);

  // A freshly spawned session should land with the caret ready to type — the point of
  // the composer is that the next keystroke is a message. Tabs stay mounted (switching
  // only toggles `display`), so this runs once per session, never on a tab switch. A
  // session started from inside an open overlay (command palette, compact session/HUD
  // sheets, ui.tsx useOverlay) mounts the box while that overlay holds `#root` inert, so
  // the focus above cannot land and the sheet's close restores the trigger instead; when
  // the last overlay tears down it removes #root's `inert` in the same synchronous task
  // as that restore, and our MutationObserver microtask runs after — so reclaim the caret
  // the moment the box becomes focusable and it isn't holding focus.
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const reclaim = () => {
      if (document.activeElement !== el) el.focus({ preventScroll: true });
    };
    reclaim();
    const root = document.getElementById("root");
    if (root === null) return;
    // Only sessions spawned under a sheet need the deferred reclaim; a normal mount
    // already focused the box above, and later overlay teardowns are no-ops here.
    if (root.getAttribute("inert") === null) return;
    const observer = new MutationObserver(() => {
      if (root.getAttribute("inert") === null) reclaim();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["inert"] });
    return () => observer.disconnect();
  }, []);

  // The shimmer runs only while focused with a keyword on screen, matching omp's
  // editor; everything else shows the static phase-0 palette.
  useEffect(() => {
    if (!focused || !glowing) {
      setPhase(0);
      return;
    }
    // A 14fps colour cycle is exactly what reduced-motion asks us not to run.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase(0);
      return;
    }
    const tick = () => setPhase((Date.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS);
    tick();
    const timer = window.setInterval(tick, SHIMMER_FRAME_MS);
    return () => window.clearInterval(timer);
  }, [focused, glowing]);

  // A dead tab has no agent to configure; and a menu left open behind a click
  // elsewhere is a stuck menu.
  useEffect(() => {
    if (dead) setEffortMenu(false);
  }, [dead]);
  useEffect(() => {
    if (!effortMenu) return;
    const dismiss = (e: PointerEvent) => {
      const anchor = effortAnchor.current;
      if (anchor !== null && e.target instanceof Node && anchor.contains(e.target)) return;
      setEffortMenu(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [effortMenu]);

  useEffect(() => {
    if (!paletteOpen && !mentionOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && composer.current?.contains(event.target)) return;
      setDismissedFor(commandWord);
      setMentionDismissedFor(mentionKey);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [paletteOpen, mentionOpen, commandWord, mentionKey]);

  const submit = useCallback(
    async (route: PromptRoute | "interrupt") => {
      let message = text.trim();
      let payload = images;
      // An image with no words is a legitimate prompt ("what is this?"), so
      // emptiness is judged on the whole draft, not the text alone.
      if ((message === "" && payload.length === 0) || dead) return;
      // Consecutive duplicates make ↑ recall useless.
      if (message !== "" && history.current[history.current.length - 1] !== message) {
        history.current.push(message);
      }
      recall.current = null;
      setText("");
      setImages([]);
      setPasteError(null);
      setDismissedFor(null);
      setMentionDismissedFor(null);
      setDismissed(storeError ?? null);

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
      if (busyRoute && projectCwd !== undefined && message.includes("@")) {
        try {
          const resolved = await backend.resolveFileMentions(projectCwd, message);
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
      dead,
      storeError,
      tabId,
      projectCwd,
      runSlashCommand,
      abortAndPrompt,
      sendPrompt,
    ],
  );

  /**
   * Intercepts an image paste. Text pastes are left entirely alone — the
   * textarea's own handling is what the user expects, and a clipboard carrying
   * both (copying an image out of a rich editor) should still paste its text.
   */
  const onPaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasClipboardImage(e.clipboardData)) return;
    // Chromium would otherwise insert the image's *filename* as text.
    e.preventDefault();
    const { images: pasted, rejected } = await readClipboardImages(e.clipboardData);
    if (pasted.length > 0) setImages((prev) => [...prev, ...pasted]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  /** Adds picker-selected Attachments through the same draft path as paste. */
  const pickImages = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Clear before reading, including rejected selections, so selecting the
    // same file again always produces another change event.
    input.value = "";
    const { images: picked, rejected } = await readImageFiles(files);
    if (picked.length > 0) setImages((prev) => [...prev, ...picked]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  const dropImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

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
    ? "agent exited — resume to continue"
    : running
      ? "steer the agent…"
      : "message the agent…   /  commands · @  files";

  // An image alone is sendable: "what is this?" is in the picture, not the text.
  const canSend = (trimmed !== "" || images.length > 0) && !dead;
  const lines = text === "" ? 0 : text.split("\n").length;

  return (
    <div ref={composer} className="ambient relative shrink-0 border-t border-line bg-sunken px-4 py-3 compact-composer">
      {busy && (
        <div className="absolute inset-x-0 -top-px">
          <ProgressSweep tone={running ? "copper" : "signal"} />
        </div>
      )}

      <div className="relative">
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
            "rounded-lg border border-line bg-raised transition-colors",
            "focus-within:border-line-strong",
            isSlash && "focus-within:border-iris-dim",
            dead && "opacity-50",
          )}
        >
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 pt-2 pb-1.5">
              {images.map((image, i) => (
                <span key={i} className="group/att relative">
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`attachment ${i + 1}`}
                    title={image.mimeType}
                    className="size-12 rounded border border-line-strong bg-sunken object-cover"
                  />
                  <span className="absolute -right-1 -top-1 opacity-0 transition-opacity group-hover/att:opacity-100 focus-within:opacity-100">
                    <IconButton
                      label={`remove attachment ${i + 1}`}
                      tone="rose"
                      onClick={() => dropImage(i)}
                      className="size-4 rounded-full border border-line-strong bg-overlay"
                    >
                      <svg viewBox="0 0 16 16" fill="none" strokeWidth={2} className="size-2.5">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
                      </svg>
                    </IconButton>
                  </span>
                </span>
              ))}
              <Label className="ml-0.5">
                {images.length} image{images.length === 1 ? "" : "s"}
              </Label>
              {!vision && (
                <Chip tone="copper" title="the selected model accepts text only — omp will drop these">
                  model has no vision
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
              rows={1}
              value={text}
              disabled={dead}
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
            <Capsule className="min-w-0">
              <ModelSelector tabId={tabId} disabled={dead} />

              <span ref={effortAnchor} className="relative flex">
                <button
                  type="button"
                  disabled={dead}
                  title={
                    efforts.length > 0
                      ? `thinking level — click to pick (${efforts.join(", ")})`
                      : "thinking level"
                  }
                  onClick={() => {
                    if (efforts.length > 0) setEffortMenu((m) => !m);
                  }}
                  className={cn(
                    CAPSULE_SEGMENT,
                    "rounded-r-[5px] font-mono text-[11px] tabular-nums text-iris",
                  )}
                >
                  {thinkingLevel ?? "think —"}
                </button>
                {effortMenu && (
                  <div className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-32 flex-col rounded-md border border-line-strong bg-overlay p-1">
                    <span className="px-1.5 pb-1 pt-0.5">
                      <Label>thinking</Label>
                    </span>
                    {efforts.map((effort) => (
                      <button
                        key={effort}
                        type="button"
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

            <AdvisorControl tabId={tabId} disabled={dead} />

            <BuildPlanControl
              tabId={tabId}
              disabled={dead}
              onSelected={() => box.current?.focus({ preventScroll: true })}
            />

            <BranchChip projectCwd={projectCwd} />

            <AttachmentButton disabled={dead} onClick={() => imagePicker.current?.click()} />


            {queued > 0 && (
              <Chip mono tone="copper" title="messages waiting for the current turn to finish">
                queued: {queued}
              </Chip>
            )}

            <span className="flex-1" />

            {text.length > COUNTER_AT && (
              <span className="font-mono tabular-nums text-ink-faint">
                {text.length}c · {lines}l
              </span>
            )}

            {running ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canSend}
                  title="abort the current turn, then send this as a fresh prompt (mod+shift+enter)"
                  onClick={() => submit("interrupt")}
                >
                  interrupt & send
                </Button>
                <Button
                  size="xs"
                  disabled={!canSend}
                  title="queue this for after the current turn (mod+enter)"
                  onClick={() => submit("follow_up")}
                >
                  queue
                </Button>
                <Button
                  size="xs"
                  tone="copper"
                  disabled={!canSend}
                  title="inject this into the running turn (enter)"
                  onClick={() => submit("steer")}
                >
                  {isSlash ? "run" : "steer"}
                </Button>
                <IconButton
                  label="abort the agent (esc)"
                  tone="rose"
                  onClick={() => void abortAgent(tabId)}
                  // The one destructive control here: readable before hover.
                  className="text-rose-dim"
                >
                  <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-4">
                    <rect
                      x="4.75"
                      y="4.75"
                      width="6.5"
                      height="6.5"
                      rx="1.25"
                      fill="currentColor"
                      stroke="currentColor"
                    />
                  </svg>
                </IconButton>
              </>
            ) : (
              <Button
                size="xs"
                variant="solid"
                disabled={!canSend}
                title={isSlash ? "run this command (enter)" : "send (enter) · shift+enter for a newline"}
                onClick={() => submit("prompt")}
              >
                {isSlash ? "run" : "send"}
              </Button>
            )}
          </div>
          )}
          {compact && (
            <div className="flex min-h-11 items-center gap-1.5 px-1.5 pb-1.5">
              <AttachmentButton compact disabled={dead} onClick={() => imagePicker.current?.click()} />
              <Button
                variant="ghost"
                title="prompt options"
                className="h-11 min-w-0 flex-1 justify-start gap-2 px-2 text-ink-mid"
                onClick={() => showCompactSurface("composer-options")}
              >
                <IconTune />
                <span className="truncate font-mono text-[11px]">{currentModel?.name || currentModel?.id || "no model"}</span>
                <span className="sr-only">prompt options</span>
              </Button>
              {queued > 0 && <Chip mono tone="copper" title="messages waiting for the current turn to finish">{queued}</Chip>}
              {running ? (
                <>
                  <Button tone="copper" variant="solid" disabled={!canSend} onClick={() => submit("steer")} className="h-11 rounded-lg px-4">{isSlash ? "Run" : "Steer"}</Button>
                  <Button tone="rose" variant="outline" onClick={() => void abortAgent(tabId)} className="h-11 rounded-lg px-3">Abort</Button>
                </>
              ) : (
                <Button variant="solid" disabled={!canSend} onClick={() => submit("prompt")} className="h-11 gap-1.5 rounded-lg px-4">
                  <IconSend />
                  {isSlash ? "Run" : "Send"}
                </Button>
              )}
            </div>
          )}
          <input
            ref={imagePicker}
            type="file"
            accept="image/*"
            multiple
            disabled={dead}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => void pickImages(event)}
          />
        </div>
      </div>
      <Sheet open={compactSurface === "composer-options"} placement="bottom" label="prompt options" onClose={closeCompactSurface}>
        <div className="prompt-options space-y-5 px-[max(1rem,var(--safe-left))] py-4 pr-[max(1rem,var(--safe-right))]">
          <section className="rounded-xl border border-line bg-raised/60 p-3">
            <Label>model &amp; effort</Label>
            <div className="mt-2 flex min-h-11 items-center rounded-lg border border-line bg-void/35 px-2">
              <ModelSelector tabId={tabId} disabled={dead} />
            </div>
            {efforts.length > 0 && (
              <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2">
                {efforts.map((effort) => <Button key={effort} selected={effort === thinkingLevel} tone="iris" onClick={() => void setThinkingLevel(tabId, effort)} className="min-h-11 min-w-0 justify-center px-2 font-mono">{effort}</Button>)}
              </div>
            )}
          </section>
          <section className="rounded-xl border border-line bg-raised/60 p-3">
            <Label>session</Label>
            <div className="mt-2 space-y-2">
              <AdvisorControl tabId={tabId} disabled={dead} layout="sheet" />
              <BuildPlanControl tabId={tabId} layout="sheet" disabled={dead} className="min-h-11" />
              <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-void/35 px-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">branch</span>
                <span className="flex min-w-0 items-center gap-2"><BranchChip projectCwd={projectCwd} />{queued > 0 && <Chip mono tone="copper">queued: {queued}</Chip>}</span>
              </div>
            </div>
          </section>
          {running && (
            <section className="rounded-xl border border-line bg-raised/60 p-3">
              <Label>while running</Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button disabled={!canSend} onClick={() => submit("follow_up")} className="min-h-11 justify-center">Queue</Button>
                <Button disabled={!canSend} onClick={() => submit("interrupt")} className="min-h-11 min-w-0 justify-center px-2">Interrupt-and-send</Button>
              </div>
            </section>
          )}
        </div>
      </Sheet>

      {error !== null && (
        <div className="animate-rise mt-2 flex items-start gap-2 text-[11px] text-rose">
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" />
            <path d="M8 5v4" stroke="currentColor" strokeLinecap="round" />
            <path d="M8 11h0" stroke="currentColor" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1 break-words" data-selectable>
            {error}
          </span>
          <IconButton label="dismiss error" tone="rose" onClick={() => setDismissed(error)}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-3">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
      )}

      {pasteError !== null && (
        <div className="animate-rise mt-2 flex items-start gap-2 text-[11px] text-copper">
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0">
            <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeLinejoin="round" />
            <path d="M8 7v3" stroke="currentColor" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1 break-words" data-selectable>
            {pasteError}
          </span>
          <IconButton label="dismiss paste warning" onClick={() => setPasteError(null)}>
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-3">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
      )}
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
