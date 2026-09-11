import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { batched } from "./pty-batch";
import type { PtyHandle } from "./pty";

function fakeHandle(): {
  handle: PtyHandle;
  emit: (b: Buffer) => void;
  kill: Mock;
} {
  let cb: ((d: Buffer) => void) | undefined;
  const kill = vi.fn();
  return {
    handle: {
      id: "fake",
      onData: (fn) => {
        cb = fn;
        return () => {
          cb = undefined;
        };
      },
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill,
    },
    emit: (b) => cb?.(b),
    kill,
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

  it("kill clears the pending flush and forwards the signal (issue #64)", () => {
    vi.useFakeTimers();
    const { handle, emit, kill } = fakeHandle();
    const seen: Buffer[] = [];
    const h = batched(handle);
    h.onData((d) => seen.push(d));

    emit(Buffer.from("pending"));
    h.kill("SIGKILL");

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    // The coalescing timer must not outlive the handle: no flush after kill.
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([]);
  });

  it("drops data arriving after kill instead of arming a new timer (issue #64)", () => {
    vi.useFakeTimers();
    const { handle, emit } = fakeHandle();
    const seen: Buffer[] = [];
    const h = batched(handle);
    h.onData((d) => seen.push(d));

    h.kill();
    emit(Buffer.from("late"));
    vi.advanceTimersByTime(100);

    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the onData unsubscribe detaches the underlying listener", () => {
    vi.useFakeTimers();
    const { handle, emit } = fakeHandle();
    const seen: Buffer[] = [];
    const off = batched(handle).onData((d) => seen.push(d));

    off();
    emit(Buffer.from("detached"));
    vi.advanceTimersByTime(5);

    expect(seen).toEqual([]);
  });
});
