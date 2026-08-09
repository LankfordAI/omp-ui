import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { cn } from "../lib/cn";

export interface PaletteNavOptions<T> {
  items: readonly T[];
  /** Changing this value restores the initial selection. */
  resetKey: unknown;
  /** Use −1 when Enter has a useful meaning without a selected row. */
  initialIndex?: number;
  onPick(item: T): void;
  onClose(): void;
  acceptTab?: boolean;
  /** Return true to consume Enter before the selected row is picked. */
  onEnter?(event: KeyboardEvent): boolean;
}

export interface PaletteNav {
  active: number;
  setActive: Dispatch<SetStateAction<number>>;
  activeRef: RefObject<HTMLButtonElement | null>;
  /** Returns true when the event belongs to the palette. */
  handleKey(event: KeyboardEvent): boolean;
}

/**
 * Shared selection mechanics for keyboard-driven palettes. Filtering and row
 * rendering stay with the feature; this hook keeps their keyboard contract in
 * one place.
 */
export function usePaletteNav<T>({
  items,
  resetKey,
  initialIndex = 0,
  onPick,
  onClose,
  acceptTab = false,
  onEnter,
}: PaletteNavOptions<T>): PaletteNav {
  const [index, setActive] = useState(initialIndex);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const minimum = initialIndex < 0 ? -1 : 0;
  const active = items.length === 0
    ? minimum
    : Math.min(Math.max(index, minimum), items.length - 1);

  useEffect(() => {
    setActive(initialIndex);
  }, [resetKey, initialIndex]);

  useEffect(() => {
    setActive((current) => items.length === 0
      ? minimum
      : Math.min(Math.max(current, minimum), items.length - 1));
  }, [items.length, minimum]);

  useEffect(() => {
    const row = active >= 0 ? activeRef.current : null;
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [active, items]);
  const handleKey = useCallback(
    (event: KeyboardEvent): boolean => {
      const key = event.key.toLowerCase();

      if (key === "escape") {
        event.preventDefault();
        onClose();
        return true;
      }

      const delta = key === "arrowdown" || (event.ctrlKey && key === "n")
        ? 1
        : key === "arrowup" || (event.ctrlKey && key === "p")
          ? -1
          : 0;
      if (delta !== 0) {
        if (items.length === 0) return false;
        event.preventDefault();
        setActive(active < 0 ? (delta > 0 ? 0 : items.length - 1) : (active + delta + items.length) % items.length);
        return true;
      }

      if (key === "enter") {
        if (onEnter?.(event) === true) {
          event.preventDefault();
          return true;
        }
        const item = active < 0 ? undefined : items[active];
        if (item === undefined) return false;
        event.preventDefault();
        onPick(item);
        return true;
      }

      if (key === "tab" && acceptTab) {
        const item = active < 0 ? undefined : items[active];
        if (item === undefined) return false;
        event.preventDefault();
        onPick(item);
        return true;
      }

      return false;
    },
    [acceptTab, active, items, onClose, onEnter, onPick],
  );

  return { active, setActive, activeRef, handleKey };
}

export function PaletteSearchHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2.5 border-b border-line px-3.5 py-3", className)} {...props} />;
}

export function PaletteList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("max-h-[24rem] overflow-y-auto py-1.5", className)} {...props} />;
}

export function PaletteEmpty({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      <p className="font-display text-sm text-ink-mid">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-ink-faint">{hint}</p>}
      {action}
    </div>
  );
}
