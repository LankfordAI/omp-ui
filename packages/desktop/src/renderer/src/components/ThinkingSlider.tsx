import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { thinkingFillGradient, thinkingLevelColor } from "../lib/thinking-colors";
import { useStore } from "../store";

/** Stable empty so the per-field selector doesn't fire on every store tick. */
const NO_EFFORTS: never[] = [];

/**
 * The options popover's thinking slider (issue #946): one stop per model
 * effort on a track coloured cool → iris → warm. A manual level paints a
 * solid fill and a filled handle; under `auto` the handle sits on the level
 * the turn resolved to, over a dashed fill, and no tick reads pressed (the
 * drifting resolved level is never the user's choice). A drag previews
 * locally and commits once on release — no RPC while the pointer moves.
 */
export function ThinkingSlider({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const t = useT();
  const efforts = useStore((s) => s.rpc[tabId]?.model?.thinking?.efforts ?? NO_EFFORTS);
  const thinkingLevel = useStore((s) => s.rpc[tabId]?.session.thinkingLevel ?? null);
  const thinkingConfigured = useStore((s) => s.rpc[tabId]?.session.thinkingConfigured ?? null);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const tickRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The drag index lives in a ref too: pointerup commits what the last move
  // previewed even when React has not re-rendered between the two events.
  const dragRef = useRef<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);

  const n = efforts.length;
  if (n === 0) return null;

  const auto = thinkingConfigured === "auto";
  const committed = efforts.indexOf(thinkingLevel ?? "");
  const index = preview ?? committed;
  const position = (i: number): string => (n > 1 ? `${(i / (n - 1)) * 100}%` : "0%");
  const pct = position(index);
  const colour = thinkingLevelColor(index, n);

  const commit = (i: number): void => {
    if (i < 0 || i >= n) return;
    if (!auto && i === committed) return;
    void setThinkingLevel(tabId, efforts[i]!);
  };

  const nearest = (x: number): number => {
    const rect = trackRef.current!.getBoundingClientRect();
    const f = rect.width > 0 ? Math.min(1, Math.max(0, (x - rect.left) / rect.width)) : 0;
    return Math.round(f * (n - 1));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return;
    trackRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = nearest(e.clientX);
    setPreview(dragRef.current);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    dragRef.current = nearest(e.clientX);
    setPreview(dragRef.current);
  };
  const onPointerUp = (): void => {
    const target = dragRef.current;
    dragRef.current = null;
    setPreview(null);
    if (target !== null) commit(target);
  };
  const onPointerCancel = (): void => {
    dragRef.current = null;
    setPreview(null);
  };

  const onTickKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    let target: number;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        target = i - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        target = i + 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    target = Math.min(n - 1, Math.max(0, target));
    tickRefs.current[target]?.focus();
    commit(target);
  };

  const tabStop = committed >= 0 ? committed : 0;

  return (
    <div className="pt-1">
      <div
        ref={trackRef}
        data-thinking-track
        className={cn(
          "relative mx-[7px] my-[9px] h-1 touch-none rounded-sm bg-line-strong",
          "before:absolute before:-inset-x-[7px] before:-inset-y-[9px] before:content-['']",
          disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {index >= 0 && (
          <div
            data-thinking-fill
            className={cn(
              "absolute inset-y-0 left-0 rounded-sm transition-[width] duration-[420ms] ease-(--ease-out-quint) motion-reduce:transition-none",
              auto && "think-dashes opacity-85",
            )}
            style={{ width: pct, backgroundImage: thinkingFillGradient(index, n) }}
          />
        )}
        {efforts.map((effort, i) => (
          <span
            key={effort}
            aria-hidden
            className="absolute top-1/2 z-[1] -ml-[5px] -mt-[5px] size-2.5 rounded-full border-2 bg-overlay transition-colors duration-300 motion-reduce:transition-none"
            style={{
              left: position(i),
              borderColor: index >= 0 && i <= index ? thinkingLevelColor(i, n) : "var(--color-line-strong)",
            }}
          />
        ))}
        {index >= 0 && (
          <div
            aria-hidden
            data-thinking-thumb
            data-index={index}
            className={cn(
              "pointer-events-none absolute top-1/2 z-[2] -ml-[7px] -mt-[7px] size-3.5 rounded-full",
              "transition-[left,background-color,box-shadow,border-color] duration-[420ms] ease-(--ease-out-quint) motion-reduce:transition-none",
              auto && "border-2 border-dashed bg-overlay",
            )}
            style={{
              left: pct,
              ...(auto
                ? { borderColor: colour }
                : {
                    backgroundColor: colour,
                    boxShadow: `0 0 0 3px color-mix(in srgb, ${colour} 24%, transparent)`,
                  }),
            }}
          />
        )}
      </div>
      <div
        role="group"
        aria-label={t("composer.thinking.label")}
        className="flex justify-between font-mono text-[10px] text-ink-mid"
      >
        {efforts.map((effort, i) => (
          <button
            key={effort}
            ref={(el) => {
              tickRefs.current[i] = el;
            }}
            type="button"
            disabled={disabled}
            aria-pressed={!auto && i === committed}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => commit(i)}
            onKeyDown={(e) => onTickKeyDown(e, i)}
            className="w-11 text-center transition-colors duration-300 first:text-left last:text-right hover:text-ink disabled:text-ink-dim motion-reduce:transition-none"
            style={i === index && !auto ? { color: thinkingLevelColor(i, n) } : undefined}
          >
            {effort}
          </button>
        ))}
      </div>
    </div>
  );
}
