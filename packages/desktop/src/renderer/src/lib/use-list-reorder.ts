import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";

/**
 * One generic drag + Alt+Arrow reorder machine for the sidebar (issue #298).
 * Rows render in a flat order but move in *units*: `rootOf` maps each row to
 * the unit key it reorders as — for a flat list the project list that is the project itself,
 * for sessions any row of a plan-handoff tree targets that tree.
 *
 * Moves are fire-and-forget store calls; the only confirmation of a keyboard
 * move waits for the registry's broadcast to land the row in the expected slot
 * (a refused or coalesced move announces nothing).
 */
export interface ListReorderOptions<TRow, TKey extends string> {
  /** The rendered rows, in order. */
  rows: TRow[];
  /** Maps a row to its reorder unit's key. */
  rootOf: (row: TRow) => TKey;
  /** The unit keys in current order — the confirm effect watches this. */
  keys: TKey[];
  /** Display name for announcements; undefined for non-reorderable keys. */
  nameOf: (key: TKey) => string | undefined;
  /** The store move: unit key + before-key (null = end of list). */
  move: (key: TKey, before: TKey | null) => void | Promise<unknown>;
  /** One gate for both drag and keyboard. */
  enabled: boolean;
  /** Live-region sink. */
  announce: (text: string) => void;
}

/** Per-row wiring bundle; close over a row's unit key with {@link ListReorder.bindRow}. */
export interface ListReorderRow {
  draggable: boolean;
  dragging: boolean;
  dropIndicator: "before" | "after" | null;
  registerGrip: (el: HTMLButtonElement | null) => void;
  onReorder: (delta: -1 | 1) => void;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

export interface ListReorder<TRow, TKey extends string> {
  /** The unit currently being dragged, or null. */
  dragKey: TKey | null;
  /** Row wiring for the row at `index` whose unit is `key`. */
  bindRow: (key: TKey, index: number) => ListReorderRow;
}

export function useListReorder<TRow, TKey extends string>(
  options: ListReorderOptions<TRow, TKey>,
): ListReorder<TRow, TKey> {
  // Rows/options/announce can change identity every render; the confirm effect
  // and the bound handlers read current values through the latest ref instead
  // of re-subscribing.
  const latest = useRef(options);
  latest.current = options;

  const [dragKey, setDragKey] = useState<TKey | null>(null);
  // The insertion line on display only; a drop recomputes the target fresh.
  const [drop, setDrop] = useState<{ index: number; indicator: "before" | "after" } | null>(null);
  // Grips are registered by unit so focus can be restored to the moved unit
  // after the broadcast re-renders the list (React moves the DOM subtree,
  // which blurs it).
  const gripRefs = useRef(new Map<TKey, HTMLButtonElement>());
  /** The keyboard move in flight, and the slot it must land in. */
  const pendingMove = useRef<{ key: TKey; name: string; index: number } | null>(null);

  // Which unit a drop lands before, given the pointer over row `index`: the
  // top half targets that row's own unit; the bottom half scans forward for
  // the first row of a different unit — or null past the end of the list.
  // Flat lists (each row its own unit) reduce to top half = own key, bottom
  // half = next key or null.
  const dropTarget = (index: number, clientY: number, rectTop: number, rectBottom: number): TKey | null => {
    const { rows, rootOf } = latest.current;
    const hovered = rows[index];
    if (hovered === undefined) return null;
    if (clientY < (rectTop + rectBottom) / 2) return rootOf(hovered);
    for (let i = index + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const unit = row === undefined ? null : rootOf(row);
      if (unit !== null && unit !== rootOf(hovered)) return unit;
    }
    return null;
  };

  // Confirm a keyboard move only on the broadcast that actually moved the row
  // into the expected slot, then restore grip focus and announce the result.
  useEffect(() => {
    const pending = pendingMove.current;
    if (pending === null || options.keys[pending.index] !== pending.key) return;
    pendingMove.current = null;
    gripRefs.current.get(pending.key)?.focus();
    latest.current.announce(
      `${pending.name} moved to position ${pending.index + 1} of ${options.keys.length}`,
    );
  }, [options.keys]);

  const bindRow = (key: TKey, index: number): ListReorderRow => ({
    draggable: latest.current.enabled,
    dragging: dragKey === key,
    dropIndicator: drop?.index === index ? drop.indicator : null,
    registerGrip: (el: HTMLButtonElement | null) => {
      if (el === null) gripRefs.current.delete(key);
      else gripRefs.current.set(key, el);
    },
    onReorder: (delta: -1 | 1) => {
      const { keys, nameOf, move, announce, enabled } = latest.current;
      if (!enabled) return;
      const i = keys.indexOf(key);
      const name = nameOf(key);
      if (i === -1 || name === undefined) return;
      const target = i + delta;
      if (target < 0 || target >= keys.length) {
        announce(`${name} is already ${delta < 0 ? "first" : "last"}`);
        return;
      }
      // The move inserts *before* a sibling unit: one step up is "before the
      // predecessor"; one step down is "before the successor's successor",
      // null past the end.
      const before = delta < 0 ? (keys[i - 1] ?? null) : (keys[i + 2] ?? null);
      pendingMove.current = { key, name, index: target };
      void move(key, before);
    },
    onDragStart: (e: ReactDragEvent<HTMLElement>) => {
      if (!latest.current.enabled) return;
      e.dataTransfer?.setData("text/plain", key); // required for Firefox
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      setDragKey(key);
    },
    onDragOver: (e: ReactDragEvent<HTMLElement>) => {
      if (dragKey === null || dragKey === key) return; // own unit: no indicator
      e.preventDefault(); // allow the drop
      const rect = e.currentTarget.getBoundingClientRect();
      const target = dropTarget(index, e.clientY, rect.top, rect.bottom);
      // "before" → insertion above this row's unit (top half); "after" →
      // below it (bottom half: before the next unit, or the end of the list).
      setDrop({ index, indicator: target === key ? "before" : "after" });
    },
    onDrop: (e: ReactDragEvent<HTMLElement>) => {
      e.preventDefault();
      if (dragKey !== null && dragKey !== key) {
        const rect = e.currentTarget.getBoundingClientRect();
        const target = dropTarget(index, e.clientY, rect.top, rect.bottom);
        // Dropping just above the dragged unit resolves to "before itself" —
        // the "leave it put" gesture. Skipping the call spares a pointless
        // save and state broadcast.
        if (target !== dragKey) void latest.current.move(dragKey, target);
      }
      setDragKey(null);
      setDrop(null);
    },
    onDragEnd: () => {
      setDragKey(null);
      setDrop(null);
    },
  });

  return { dragKey, bindRow };
}
