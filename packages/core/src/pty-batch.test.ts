import { afterEach, describe, expect, it, vi } from "vitest";
import { batched } from "./pty-batch";
import type { PtyHandle } from "./pty";

function fakeHandle(): { handle: PtyHandle; emit: (b: Buffer) => void } {
  let cb: ((d: Buffer) => void) | undefined;
  return {
    handle: {
      id: "fake",
      onData: (fn) => {
        cb = fn;
      },
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    },
    emit: (b) => cb?.(b),
  };
}

describe("batched", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst inside the window into one concatenated buffer", () => {
    vi.useFakeTimers();
    const { handle, emit } = fakeHandle();
    const seen: Buffer[] = [];
    batched(handle).onData((d) => seen.push(d));

    emit(Buffer.from("aaa"));
    emit(Buffer.from("bb"));
    emit(Buffer.from("c"));
    vi.advanceTimersByTime(5);

    expect(seen).toEqual([Buffer.from("aaabbc")]);
  });

  it("passes a single chunk through as-is", () => {
    vi.useFakeTimers();
    const { handle, emit } = fakeHandle();
    const seen: Buffer[] = [];
    batched(handle).onData((d) => seen.push(d));

    const solo = Buffer.from("solo");
    emit(solo);
    vi.advanceTimersByTime(5);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(solo);
  });

  it("emits separate windows as separate callbacks", () => {
    vi.useFakeTimers();
    const { handle, emit } = fakeHandle();
    const seen: Buffer[] = [];
    batched(handle).onData((d) => seen.push(d));

    emit(Buffer.from("one"));
    vi.advanceTimersByTime(5);
    emit(Buffer.from("two"));
    vi.advanceTimersByTime(5);

    expect(seen).toEqual([Buffer.from("one"), Buffer.from("two")]);
  });
});
