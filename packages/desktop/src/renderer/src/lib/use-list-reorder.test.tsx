// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useListReorder } from "./use-list-reorder";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
  /** The reorder unit this row targets (a tree id for nested rows). */
  unit: string;
  name: string;
}

interface HarnessProps {
  rows: Row[];
  keys: string[];
  move: (key: string, before: string | null) => void;
  announce: (text: string) => void;
}

/**
 * Renders the rows and wires the bindRow bundle to real drag events plus a
 * grip per unit (the first row of each unit). Mirrors how Sidebar binds the
 * hook: the unit key is `rootOf(row)`, the index is the row's position.
 */
function Harness({ rows, keys, move, announce }: HarnessProps) {
  const { bindRow } = useListReorder({
    rows,
    rootOf: (row) => row.unit,
    keys,
    nameOf: (unit) => rows.find((r) => r.unit === unit)?.name,
    move,
    enabled: true,
    announce,
  });
  return (
    <div>
      {rows.map((row, index) => {
        const r = bindRow(row.unit, index);
        const isRoot = rows.findIndex((x) => x.unit === row.unit) === index;
        return (
          <div
            key={row.id}
            data-testid={`row-${row.id}`}
            draggable={r.draggable}
            data-dragging={r.dragging || undefined}
            data-drop-indicator={r.dropIndicator ?? undefined}
            onDragStart={r.onDragStart}
            onDragOver={r.onDragOver}
            onDrop={r.onDrop}
            onDragEnd={r.onDragEnd}
          >
            {row.name}
            {isRoot && (
              <button
                type="button"
                ref={r.registerGrip}
                aria-label={`reorder ${row.name}`}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  r.onReorder(e.key === "ArrowUp" ? -1 : 1);
                }}
              >
                grip
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

let root: Root | null = null;

/** Mount; the returned setter re-renders the same tree (simulating a broadcast). */
function mount(props: HarnessProps): (next: HarnessProps) => void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness {...props} />));
  return (next) => act(() => root!.render(<Harness {...next} />));
}

/** Deterministic geometry: every row spans y 0–100, so clientY 40 = top half. */
function mockRowRects(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    height: 100,
    left: 0,
    right: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

// jsdom's MouseEvent carries no dataTransfer; the hook null-guards it, so a
// plain fixture suffices.
const dragEvent = (type: string, clientY: number): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientY });

const row = (id: string): HTMLElement =>
  document.querySelector(`[data-testid="row-${id}"]`) as HTMLElement;

const grip = (name: string): HTMLButtonElement =>
  document.querySelector(`button[aria-label="reorder ${name}"]`) as HTMLButtonElement;

const press = async (el: HTMLElement, key: string): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true }));
  });
};

const flatRows: Row[] = [
  { id: "a", unit: "a", name: "Alpha" },
  { id: "b", unit: "b", name: "Beta" },
  { id: "c", unit: "c", name: "Gamma" },
];
const flatKeys = ["a", "b", "c"];

/** Three trees, each a root row plus one child (children share the unit). */
const treeRows: Row[] = [
  { id: "t1r", unit: "t1", name: "One root" },
  { id: "t1c", unit: "t1", name: "One child" },
  { id: "t2r", unit: "t2", name: "Two root" },
  { id: "t2c", unit: "t2", name: "Two child" },
  { id: "t3r", unit: "t3", name: "Three root" },
  { id: "t3c", unit: "t3", name: "Three child" },
];
const treeKeys = ["t1", "t2", "t3"];

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useListReorder — flat list", () => {
  beforeEach(() => mockRowRects());

  it("marks the row being dragged once dragstart fires", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: flatRows, keys: flatKeys, move, announce });
    await act(async () => {
      row("a").dispatchEvent(dragEvent("dragstart", 0));
    });
    expect(row("a").getAttribute("data-dragging")).toBe("true");
    expect(row("b").hasAttribute("data-dragging")).toBe(false);
  });

  it("shows the insertion line by pointer half: top 'before', bottom 'after'", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: flatRows, keys: flatKeys, move, announce });
    await act(async () => {
      row("a").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("c").dispatchEvent(dragEvent("dragover", 40));
    });
    expect(row("c").getAttribute("data-drop-indicator")).toBe("before");
    await act(async () => {
      row("c").dispatchEvent(dragEvent("dragover", 60));
    });
    expect(row("c").getAttribute("data-drop-indicator")).toBe("after");
  });

  it("moves before the successor when dropped on the middle row's bottom half", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: flatRows, keys: flatKeys, move, announce });
    await act(async () => {
      row("a").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("b").dispatchEvent(dragEvent("drop", 60));
    });
    expect(move).toHaveBeenCalledWith("a", "c");
    expect(row("b").getAttribute("data-drop-indicator")).toBeNull();
  });

  it("appends when dropped on the last row's bottom half", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: flatRows, keys: flatKeys, move, announce });
    await act(async () => {
      row("a").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("c").dispatchEvent(dragEvent("drop", 60));
    });
    expect(move).toHaveBeenCalledWith("a", null);
  });

  it("is a no-op when dropped back onto the dragged row", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: flatRows, keys: flatKeys, move, announce });
    await act(async () => {
      row("b").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("b").dispatchEvent(dragEvent("drop", 40));
    });
    await act(async () => {
      row("b").dispatchEvent(dragEvent("drop", 60));
    });
    expect(move).not.toHaveBeenCalled();
  });

  it("announces and refocuses the grip once the broadcast lands the row", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    const rerender = mount({ rows: flatRows, keys: flatKeys, move, announce });
    await press(grip("Alpha"), "ArrowDown");
    expect(move).toHaveBeenCalledWith("a", "c");
    // Nothing is announced until the broadcast replaces the keys.
    expect(announce).not.toHaveBeenCalled();

    await rerender({ rows: [flatRows[1]!, flatRows[0]!, flatRows[2]!], keys: ["b", "a", "c"], move, announce });
    expect(announce).toHaveBeenCalledWith("Alpha moved to position 2 of 3");
    expect(document.activeElement).toBe(grip("Alpha"));
  });

  it("refuses to move past either end and says so instead", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: flatRows, keys: flatKeys, move, announce });
    await press(grip("Alpha"), "ArrowUp");
    expect(move).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith("Alpha is already first");
    await press(grip("Gamma"), "ArrowDown");
    expect(move).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith("Gamma is already last");
  });

  it("announces nothing when the keys never show the expected slot", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    const rerender = mount({ rows: flatRows, keys: flatKeys, move, announce });
    await press(grip("Alpha"), "ArrowDown");
    expect(move).toHaveBeenCalledWith("a", "c");
    // A re-render that leaves the order unchanged (refused/coalesced move).
    await rerender({ rows: flatRows, keys: ["a", "b", "c"], move, announce });
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("useListReorder — tree units", () => {
  beforeEach(() => mockRowRects());

  it("resolves a drop on a CHILD row to its tree's root unit", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: treeRows, keys: treeKeys, move, announce });
    await act(async () => {
      row("t1r").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("t2c").dispatchEvent(dragEvent("dragover", 40));
    });
    // Top half of any row of a tree = before that tree.
    expect(row("t2c").getAttribute("data-drop-indicator")).toBe("before");
  });

  it("targets the next root's key on a tree's last row's bottom half", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: treeRows, keys: treeKeys, move, announce });
    await act(async () => {
      row("t1r").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("t2c").dispatchEvent(dragEvent("dragover", 60));
    });
    expect(row("t2c").getAttribute("data-drop-indicator")).toBe("after");
    await act(async () => {
      row("t2c").dispatchEvent(dragEvent("drop", 60));
    });
    expect(move).toHaveBeenCalledWith("t1", "t3");
  });

  it("targets null (end of list) on the final tree's last row's bottom half", async () => {
    const move = vi.fn();
    const announce = vi.fn();
    mount({ rows: treeRows, keys: treeKeys, move, announce });
    await act(async () => {
      row("t1r").dispatchEvent(dragEvent("dragstart", 0));
    });
    await act(async () => {
      row("t3c").dispatchEvent(dragEvent("drop", 60));
    });
    expect(move).toHaveBeenCalledWith("t1", null);
  });
});
