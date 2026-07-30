import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import type { ImageAttachment } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages } from "../lib/clipboard-image";
import type { PromptRoute } from "../lib/rpc-types";
import { useStore } from "../store";
import { AdvisorControl } from "./AdvisorControl";
import { ModelSelector } from "./ModelSelector";
import { SlashPalette, type SlashPaletteHandle } from "./SlashPalette";
import { Button, Chip, IconButton, Label, ProgressSweep } from "./ui";

/**
 * The composer. Everything the user can *say* to a live agent lives here:
 * prompt, steer, queue a follow-up, abort, and interrupt-and-replace — omp
 * exposes all five and the old single-line input reached only the first.
 */

/** Beyond this the textarea scrolls instead of growing. */
const MAX_ROWS = 12;
/** A counter below this is noise; above it the user is writing something long. */
const COUNTER_AT = 400;

export function Composer({ tabId }: { tabId: string }) {
  const status = useStore((s) => s.rpc[tabId]?.status);
  const busy = useStore((s) => s.rpc[tabId]?.busy ?? false);
  const storeError = useStore((s) => s.rpc[tabId]?.error);
  const commands = useStore((s) => s.rpc[tabId]?.commands ?? NO_COMMANDS);
  const queued = useStore((s) => s.rpc[tabId]?.session.queuedMessageCount ?? 0);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const dead = useStore((s) => s.exited[tabId] !== undefined);

  const sendPrompt = useStore((s) => s.sendPrompt);
  const abortAgent = useStore((s) => s.abortAgent);
  const abortAndPrompt = useStore((s) => s.abortAndPrompt);
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const cycleThinkingLevel = useStore((s) => s.cycleThinkingLevel);

  const [text, setText] = useState("");
  /**
   * The `/command` whose palette the user dismissed. Scoped to the word, not a
   * bare boolean: Escape on `/todo` must not keep the palette shut when the
   * user then clears the line and types `/compact`.
   */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [effortMenu, setEffortMenu] = useState(false);
  /** Errors are store-owned, so dismissal remembers the message it hid. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /**
   * Images pasted into this draft, in paste order. They ride the same frame as
   * the text — omp appends them after the text block — and are cleared with it.
   */
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** Why a pasted item was refused (over omp's 20 MB ceiling, unreadable). */
  const [pasteError, setPasteError] = useState<string | null>(null);

  const box = useRef<HTMLTextAreaElement | null>(null);
  const palette = useRef<SlashPaletteHandle | null>(null);
  const effortAnchor = useRef<HTMLSpanElement | null>(null);
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
  /**
   * omp reports vision support as `model.input` containing "image". A model
   * without it would silently drop the blocks, so the affordance says so
   * instead of failing quietly.
   */
  const vision = useStore((s) => s.rpc[tabId]?.model?.input?.includes("image") ?? true);

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
    const max = line * MAX_ROWS + padding + border;
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? "auto" : "hidden";
  }, [text]);

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

  const submit = useCallback(
    (route: PromptRoute | "interrupt") => {
      const message = text.trim();
      // An image with no words is a legitimate prompt ("what is this?"), so
      // emptiness is judged on the whole draft, not the text alone.
      if ((message === "" && images.length === 0) || dead) return;
      // Consecutive duplicates make ↑ recall useless.
      if (message !== "" && history.current[history.current.length - 1] !== message) {
        history.current.push(message);
      }
      recall.current = null;
      setText("");
      setImages([]);
      setPasteError(null);
      setDismissedFor(null);
      setDismissed(storeError ?? null);

      // A leading "/" is a command, never a prompt — even mid-run. Commands take
      // no images, so any attached here would be silently dropped by omp;
      // holding them back would be worse, since the draft is already cleared.
      if (message.startsWith("/")) {
        void runSlashCommand(tabId, message);
      } else if (route === "interrupt") {
        void abortAndPrompt(tabId, message, images);
      } else {
        void sendPrompt(tabId, message, route, images);
      }
      box.current?.focus();
    },
    [text, images, dead, storeError, tabId, runSlashCommand, abortAndPrompt, sendPrompt],
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
        box.current?.focus();
        return;
      }
      setText("");
      setDismissedFor(null);
      void runSlashCommand(tabId, `/${name}`);
      box.current?.focus();
    },
    [tabId, runSlashCommand],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The palette gets first refusal on navigation keys while it is open.
    if (paletteOpen && palette.current?.handleKey(e) === true) return;

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
      submit(e.shiftKey ? "interrupt" : "follow_up");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(running ? "steer" : "prompt");
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
      : "message the agent…   /  for commands";

  // An image alone is sendable: "what is this?" is in the picture, not the text.
  const canSend = (trimmed !== "" || images.length > 0) && !dead;
  const lines = text === "" ? 0 : text.split("\n").length;

  return (
    <div className="relative shrink-0 border-t border-line bg-sunken px-4 py-3">
      {busy && (
        <div className="absolute inset-x-0 -top-px">
          <ProgressSweep tone={running ? "copper" : "signal"} />
        </div>
      )}

      <div className="relative">
        {paletteOpen && (
          <SlashPalette
            ref={palette}
            commands={commands}
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
          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={dead}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              recall.current = null;
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => void onPaste(e)}
            className={cn(
              "block w-full resize-none bg-transparent px-3 py-2 outline-none",
              "text-sm leading-relaxed placeholder:text-ink-faint",
              isSlash ? "font-mono" : "font-sans",
            )}
          />

          <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[11px]">
            <ModelSelector tabId={tabId} disabled={dead} />

            <span ref={effortAnchor} className="relative">
              <button
                type="button"
                disabled={dead}
                title={
                  efforts.length > 0
                    ? `thinking level — click to cycle, right-click to pick (${efforts.join(", ")})`
                    : "thinking level — click to cycle"
                }
                onClick={() => void cycleThinkingLevel(tabId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (efforts.length > 0) setEffortMenu(!effortMenu);
                }}
                className="rounded disabled:pointer-events-none disabled:opacity-35"
              >
                <Chip mono tone="iris">{thinkingLevel ?? "think —"}</Chip>
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

            <AdvisorControl tabId={tabId} disabled={dead} />

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
        </div>
      </div>

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

/** Stable empties keep the per-field selectors from firing on every store tick. */
const NO_COMMANDS: never[] = [];
const NO_EFFORTS: never[] = [];
