import { describe, expect, it } from "vitest";
import {
  acceleratorName,
  compositionEnd,
  keyEvents,
  mapPointer,
  pointerEvents,
  wheelEvents,
  type KeyLike,
  type PointerLike,
  type WheelLike,
} from "./browser-pane-input";

const FLAGS = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, capsLock: false };

/** A 1280×800 CSS page painted at dsf 2 into a box half its size. */
const CTX = { box: { width: 640, height: 400 }, header: { width: 2560, height: 1600, dsf: 2 } };

const pointer = (over: Partial<PointerLike> = {}): PointerLike => ({
  ...FLAGS,
  offsetX: 100,
  offsetY: 50,
  button: 0,
  buttons: 0,
  detail: 1,
  ...over,
});

const key = (over: Partial<KeyLike> = {}): KeyLike => ({
  ...FLAGS,
  key: "a",
  location: 0,
  isComposing: false,
  ...over,
});

const wheel = (over: Partial<WheelLike> = {}): WheelLike => ({
  ...FLAGS,
  offsetX: 100,
  offsetY: 50,
  deltaX: 0,
  deltaY: 120,
  deltaMode: 0,
  ...over,
});

describe("browser pane pointer translation", () => {
  it("maps canvas offsets through the frame's CSS size, not its physical size", () => {
    // 100 px into a 640 px box showing a 1280 CSS px page = 200 CSS px.
    expect(mapPointer(100, 50, CTX.box, CTX.header)).toEqual({ x: 200, y: 100 });
    // Rounded to half pixels.
    expect(mapPointer(100.3, 0, { width: 1000, height: 1000 }, { width: 1000, height: 1000, dsf: 1 })).toEqual({
      x: 100.5,
      y: 0,
    });
  });

  it("maps left/middle/right and drops the rest", () => {
    expect(pointerEvents("down", pointer({ button: 0 }), CTX)).toEqual([
      { type: "mouseDown", x: 200, y: 100, button: "left", clickCount: 1, modifiers: undefined },
    ]);
    expect(pointerEvents("up", pointer({ button: 1, detail: 2 }), CTX)).toEqual([
      { type: "mouseUp", x: 200, y: 100, button: "middle", clickCount: 2, modifiers: undefined },
    ]);
    expect(pointerEvents("down", pointer({ button: 3 }), CTX)).toEqual([]);
    expect(pointerEvents("down", pointer({ button: 4 }), CTX)).toEqual([]);
  });

  it("sends a right press as down+up and nothing on its release", () => {
    expect(pointerEvents("down", pointer({ button: 2 }), CTX).map((e) => e.type)).toEqual([
      "mouseDown",
      "mouseUp",
    ]);
    expect(pointerEvents("up", pointer({ button: 2 }), CTX)).toEqual([]);
  });

  it("a drag carries the pressed button and its modifier; a leave only the point", () => {
    expect(pointerEvents("move", pointer({ buttons: 1, shiftKey: true }), CTX)).toEqual([
      { type: "mouseMove", x: 200, y: 100, button: "left", modifiers: ["shift", "left"] },
    ]);
    expect(pointerEvents("move", pointer(), CTX)).toEqual([
      { type: "mouseMove", x: 200, y: 100, modifiers: undefined },
    ]);
    expect(pointerEvents("leave", pointer(), CTX)).toEqual([{ type: "mouseLeave", x: 200, y: 100 }]);
  });
});

describe("browser pane wheel translation", () => {
  it("negates the DOM sign and flags pixel deltas as precise", () => {
    expect(wheelEvents(wheel({ deltaX: 10, deltaY: 120 }), CTX)).toEqual([
      {
        type: "mouseWheel",
        x: 200,
        y: 100,
        deltaX: -10,
        deltaY: -120,
        hasPreciseScrollingDeltas: true,
        modifiers: undefined,
      },
    ]);
  });

  it("scales line and page deltas into pixels", () => {
    const [lines] = wheelEvents(wheel({ deltaY: 3, deltaMode: 1 }), CTX);
    expect(lines).toMatchObject({ deltaY: -48, hasPreciseScrollingDeltas: false });
    const [pages] = wheelEvents(wheel({ deltaY: -1, deltaMode: 2 }), CTX);
    expect(pages).toMatchObject({ deltaY: 400, hasPreciseScrollingDeltas: false });
  });
});

describe("browser pane key translation", () => {
  const nonDarwin = { darwin: false };
  const darwin = { darwin: true };

  it("a printable key is keyDown + char, then keyUp", () => {
    expect(keyEvents("keydown", key({ key: "a" }), nonDarwin)).toEqual({
      preventDefault: true,
      events: [
        { type: "keyDown", keyCode: "A", modifiers: undefined },
        { type: "char", keyCode: "a", modifiers: undefined },
      ],
    });
    expect(keyEvents("keyup", key({ key: "a" }), nonDarwin).events).toEqual([
      { type: "keyUp", keyCode: "A", modifiers: undefined },
    ]);
    // A surrogate pair is one grapheme.
    expect(keyEvents("keydown", key({ key: "😀" }), nonDarwin).events.map((e) => e.type)).toEqual([
      "keyDown",
      "char",
    ]);
  });

  it("emits no char under ctrl or meta", () => {
    expect(keyEvents("keydown", key({ key: "c", ctrlKey: true }), nonDarwin).events).toEqual([
      { type: "keyDown", keyCode: "C", modifiers: ["control"] },
    ]);
    expect(keyEvents("keydown", key({ key: "c", metaKey: true }), nonDarwin).events).toEqual([
      { type: "keyDown", keyCode: "C", modifiers: ["meta"] },
    ]);
  });

  it("spells accelerator names Electron's way and drops the unknown", () => {
    expect(acceleratorName(" ")).toBe("Space");
    expect(acceleratorName("Enter")).toBe("Return");
    expect(acceleratorName("ArrowLeft")).toBe("Left");
    expect(acceleratorName("PageDown")).toBe("PageDown");
    expect(acceleratorName("F12")).toBe("F12");
    expect(acceleratorName("7")).toBe("7");
    expect(acceleratorName("/")).toBe("/");
    expect(acceleratorName("Dead")).toBeNull();
    expect(acceleratorName("Shift")).toBeNull();
    expect(acceleratorName("F25")).toBeNull();
    expect(keyEvents("keydown", key({ key: "Dead" }), nonDarwin)).toEqual({ events: [], preventDefault: false });
    // Enter is a control key: no char, and the keypad reports isKeypad.
    expect(keyEvents("keydown", key({ key: "Enter", location: 3 }), nonDarwin).events).toEqual([
      { type: "keyDown", keyCode: "Return", modifiers: ["isKeypad"] },
    ]);
  });

  it("drops composing keys and commits the composition as insertText", () => {
    expect(keyEvents("keydown", key({ key: "ㅎ", isComposing: true }), nonDarwin)).toEqual({
      events: [],
      preventDefault: false,
    });
    expect(compositionEnd("한글")).toEqual([{ type: "insertText", text: "한글" }]);
    expect(compositionEnd("")).toEqual([]);
  });

  it("darwin ⌘ chords become edit commands, ⇧⌘Z redo, and produce no keyUp", () => {
    const chord = (k: string, shift = false) =>
      keyEvents("keydown", key({ key: k, metaKey: true, shiftKey: shift }), darwin).events;
    expect(chord("a")).toEqual([{ type: "edit", command: "selectAll" }]);
    expect(chord("c")).toEqual([{ type: "edit", command: "copy" }]);
    expect(chord("v")).toEqual([{ type: "edit", command: "paste" }]);
    expect(chord("x")).toEqual([{ type: "edit", command: "cut" }]);
    expect(chord("z")).toEqual([{ type: "edit", command: "undo" }]);
    expect(chord("Z", true)).toEqual([{ type: "edit", command: "redo" }]);
    expect(keyEvents("keyup", key({ key: "c", metaKey: true }), darwin)).toEqual({
      events: [],
      preventDefault: true,
    });
  });

  it("other darwin ⌘ chords are key events carrying meta", () => {
    expect(keyEvents("keydown", key({ key: "l", metaKey: true }), darwin).events).toEqual([
      { type: "keyDown", keyCode: "L", modifiers: ["meta"] },
    ]);
  });

  it("⌘ never becomes an edit command off darwin", () => {
    expect(keyEvents("keydown", key({ key: "v", metaKey: true }), nonDarwin).events).toEqual([
      { type: "keyDown", keyCode: "V", modifiers: ["meta"] },
    ]);
  });
});
