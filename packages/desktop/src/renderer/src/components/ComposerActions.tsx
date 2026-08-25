import type { PromptRoute } from "../lib/rpc-types";
import { Button, IconButton, Label } from "./ui";

/**
 * The composer's running/idle send cluster, one component across all three
 * surfaces (issue #299): the desktop action row, the compact row, and the
 * compact options sheet. The route verbs are pure fire-and-forget triggers —
 * the parent's submit owns the ordered worktree-conversion and
 * mention-resolution awaits, which this component never touches.
 */
export type ComposerActionsLayout = "desktop" | "compact" | "sheet";

/** Arrow-up send glyph for the compact primary control. */
function IconSend() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

export function ComposerActions({
  layout,
  running,
  isSlash,
  canSend,
  onSubmit,
  onAbort,
}: {
  layout: ComposerActionsLayout;
  running: boolean;
  /**
   * A slash draft is a command, not a prompt: every route verb reads "run".
   * The sheet layout ignores this — its labels are fixed (Queue,
   * Interrupt-and-send); callers pass false there.
   */
  isSlash: boolean;
  canSend: boolean;
  onSubmit: (route: PromptRoute | "interrupt") => void;
  onAbort: () => void;
}) {
  const label = (verb: "send" | "steer") => {
    const word = isSlash ? "run" : verb;
    return layout === "compact" ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  };

  if (layout === "sheet") {
    if (!running) return null;
    return (
      <section className="rounded-xl border border-line bg-raised/60 p-3">
        <Label>while running</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button disabled={!canSend} onClick={() => onSubmit("follow_up")} className="min-h-11 justify-center">Queue</Button>
          <Button disabled={!canSend} onClick={() => onSubmit("interrupt")} className="min-h-11 min-w-0 justify-center px-2">Interrupt-and-send</Button>
        </div>
      </section>
    );
  }

  if (layout === "compact") {
    return running ? (
      <>
        <Button tone="copper" variant="solid" disabled={!canSend} onClick={() => onSubmit("steer")} className="h-11 rounded-lg px-4">{label("steer")}</Button>
        <Button tone="rose" variant="outline" onClick={onAbort} className="h-11 rounded-lg px-3">Abort</Button>
      </>
    ) : (
      <Button variant="solid" disabled={!canSend} onClick={() => onSubmit("prompt")} className="h-11 gap-1.5 rounded-lg px-4">
        <IconSend />
        {label("send")}
      </Button>
    );
  }

  return running ? (
    <>
      <Button
        size="xs"
        variant="ghost"
        disabled={!canSend}
        title="abort the current turn, then send this as a fresh prompt (mod+shift+enter)"
        onClick={() => onSubmit("interrupt")}
        className="min-w-0 shrink"
      >
        <span className="min-w-0 truncate">interrupt & send</span>
      </Button>
      <Button
        size="xs"
        disabled={!canSend}
        title="queue this for after the current turn (mod+enter)"
        onClick={() => onSubmit("follow_up")}
      >
        queue
      </Button>
      <Button
        size="xs"
        tone="copper"
        disabled={!canSend}
        title="inject this into the running turn (enter)"
        onClick={() => onSubmit("steer")}
      >
        {label("steer")}
      </Button>
      <IconButton
        label="abort the agent (esc)"
        tone="rose"
        onClick={onAbort}
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
      onClick={() => onSubmit("prompt")}
    >
      {label("send")}
    </Button>
  );
}
