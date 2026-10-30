import { useEffect, useRef, useState } from "react";
import type { PromptRoute } from "../lib/rpc-types";
import type { SubmitRoute } from "./Composer";
import { cn } from "../lib/cn";
import { formatHotkey } from "../lib/hotkeys";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import { MenuRow } from "./MenuRow";
import { Button, Chevron, IconButton, Label } from "./ui";

/**
 * The composer's running/idle send cluster, one component across all three
 * surfaces (issue #299): the desktop action row, the compact row, and the
 * compact options sheet. The route verbs are pure fire-and-forget triggers —
 * the parent's submit owns the ordered worktree-conversion and
 * mention-resolution awaits, which this component never touches.
 */
export type ComposerActionsLayout = "desktop" | "compact" | "sheet";

/** Arrow-up send glyph for the idle primary control. */
function IconSend() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

export function ComposerActions({
  layout,
  atReset = null,
  running,
  isSlash,
  canSend,
  onSubmit,
  onAbort,
}: {
  layout: ComposerActionsLayout;
  /**
   * Send at reset (issue #986): the provider's reset as a local clock label,
   * offered beside idle Send while the session is limited. Null hides it.
   */
  atReset?: { when: string; canHold: boolean } | null;
  running: boolean;
  /**
   * A slash draft is a command, not a prompt: every route verb reads "run".
   * The sheet layout ignores this — its labels are fixed (Queue,
   * Interrupt-and-send); callers pass false there.
   */
  isSlash: boolean;
  canSend: boolean;
  onSubmit: (route: SubmitRoute) => void;
  onAbort: () => void;
}) {
  const t = useT();
  const atResetButton = atReset !== null && !running && (
    <Button
      variant="outline"
      tone="copper"
      disabled={!atReset.canHold}
      title={t("composer.actions.sendAtResetTitle", { when: atReset.when })}
      onClick={() => onSubmit("at-reset")}
      className={layout === "compact" ? "h-11 rounded-lg px-3" : "h-7 shrink-0 rounded-full px-2.5 text-[11px]"}
    >
      {t("composer.actions.sendAtReset", { when: atReset.when })}
    </Button>
  );
  const label = (verb: "send" | "steer") => {
    const word =
      isSlash
        ? t("composer.actions.run")
        : verb === "send"
          ? t("composer.actions.send")
          : t("composer.actions.steer");
    return layout === "compact" ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  };

  if (layout === "sheet") {
    if (!running) return null;
    return (
      <section className="rounded-xl border border-line bg-raised/60 p-3">
        <Label>{t("composer.actions.whileRunning")}</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button disabled={!canSend} onClick={() => onSubmit("follow_up")} className="min-h-11 justify-center">
            {t("composer.actions.sheetQueue")}
          </Button>
          <Button disabled={!canSend} onClick={() => onSubmit("interrupt")} className="min-h-11 min-w-0 justify-center px-2">
            {t("composer.actions.sheetInterrupt")}
          </Button>
        </div>
      </section>
    );
  }

  if (layout === "compact") {
    return running ? (
      <>
        <Button tone="copper" variant="solid" disabled={!canSend} onClick={() => onSubmit("steer")} className="h-11 rounded-lg px-4">{label("steer")}</Button>
        <Button tone="rose" variant="outline" onClick={onAbort} className="h-11 rounded-lg px-3">{t("composer.actions.abort")}</Button>
      </>
    ) : (
      <>
        {atResetButton}
        <Button variant="solid" disabled={!canSend} onClick={() => onSubmit("prompt")} className="h-11 gap-1.5 rounded-lg px-4">
          <IconSend />
          {label("send")}
        </Button>
      </>
    );
  }

  return running ? (
    <>
      <SteerSplit steerLabel={label("steer")} canSend={canSend} onSubmit={onSubmit} />
      <IconButton
        label={t("composer.actions.abortLabel")}
        tone="rose"
        onClick={onAbort}
        // The one destructive control here: readable before hover.
        className="size-7 rounded-full border border-rose-dim/50 bg-rose-wash text-rose"
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
    <>
      {atResetButton}
      <Button
        variant="solid"
        disabled={!canSend}
        title={isSlash ? t("composer.actions.runTitle") : t("composer.actions.sendTitle")}
        onClick={() => onSubmit("prompt")}
        className="size-7 shrink-0 justify-center rounded-full p-0"
      >
        <IconSend />
        <span className="sr-only">{label("send")}</span>
      </Button>
    </>
  );
}

/**
 * The desktop running primary (issue #939): steer, with queue and
 * interrupt-and-send behind its chevron. Unmounts with the running branch,
 * which drops an open menu when the turn ends.
 */
function SteerSplit({
  steerLabel,
  canSend,
  onSubmit,
}: {
  steerLabel: string;
  canSend: boolean;
  onSubmit: (route: PromptRoute | "interrupt") => void;
}) {
  const t = useT();
  const [routes, setRoutes] = useState(false);
  const splitRoot = useRef<HTMLSpanElement | null>(null);
  const chevron = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = () => setRoutes(false);
  useDismissal({
    open: routes,
    refs: splitRoot,
    onClose: close,
    onEscape: close,
    restoreFocus: () => chevron.current?.focus(),
  });
  useEffect(() => {
    if (routes) menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [routes]);
  useEffect(() => {
    if (!canSend) setRoutes(false);
  }, [canSend]);
  const pick = (route: PromptRoute | "interrupt") => {
    setRoutes(false);
    onSubmit(route);
  };

  return (
    <span ref={splitRoot} className="relative flex shrink-0">
      <Button
        size="xs"
        tone="copper"
        disabled={!canSend}
        title={t("composer.actions.steerTitle")}
        onClick={() => onSubmit("steer")}
        className="rounded-r-none"
      >
        {steerLabel}
      </Button>
      {/* A plain button: Button carries no aria-haspopup. Classes mirror Button size="xs" tone="copper". */}
      <button
        ref={chevron}
        type="button"
        aria-haspopup="menu"
        aria-expanded={routes}
        aria-label={t("composer.actions.moreRoutes")}
        title={t("composer.actions.moreRoutes")}
        disabled={!canSend}
        onClick={() => setRoutes((o) => !o)}
        className={cn(
          "inline-flex h-6 shrink-0 items-center rounded-md rounded-l-none border border-l-0 px-1 font-medium",
          "transition-[background-color,border-color,color,filter,opacity] duration-150",
          "border-copper-dim/50 bg-copper-wash text-copper hover:border-copper-dim",
          "disabled:pointer-events-none disabled:border-line disabled:bg-transparent disabled:text-ink-dim",
        )}
      >
        <Chevron open={false} className="rotate-90" />
      </button>
      {routes && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("composer.actions.moreRoutes")}
          className="animate-rise edge-lit absolute bottom-full right-0 z-20 mb-1 flex w-60 flex-col rounded-md border border-line-strong bg-overlay p-1"
        >
          <MenuRow
            label={t("composer.actions.queue")}
            hint={formatHotkey("mod+enter")}
            title={t("composer.actions.queueTitle")}
            onClick={() => pick("follow_up")}
          />
          <MenuRow
            label={t("composer.actions.interruptSend")}
            hint={formatHotkey("mod+shift+enter")}
            title={t("composer.actions.interruptTitle")}
            onClick={() => pick("interrupt")}
          />
        </div>
      )}
    </span>
  );
}
