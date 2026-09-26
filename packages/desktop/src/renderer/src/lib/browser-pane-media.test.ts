import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopMediaGeometry, DesktopMediaLease, DesktopMediaMessage } from "../../../browser-pane-desktop-protocol";
import { createMediaPainter, type MediaPainterDependencies } from "./browser-pane-media";

const geometry: DesktopMediaGeometry = { width: 2271, height: 2005, dsf: 1.5, surfaceWidth: 2272, surfaceHeight: 2006 };
const lease = (generation = 1, size = geometry): DesktopMediaLease => ({ sourceId: `source-${generation}`, generation, geometry: size });
const settle = async (): Promise<void> => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function source() {
  const events = new EventTarget();
  const stop = vi.fn();
  const track = {
    stop, readyState: "live",
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  let pending = Promise.withResolvers<ReadableStreamReadResult<VideoFrame>>();
  const reader = {
    read: () => pending.promise,
    // Deliberately permit a late frame after cancellation to exercise the painter's fence.
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  };
  const readable = { getReader: () => reader } as unknown as ReadableStream<VideoFrame>;
  const deliver = (width = geometry.surfaceWidth, height = geometry.surfaceHeight) => {
    const frame = { displayWidth: width, displayHeight: height, close: vi.fn() } as unknown as VideoFrame;
    const previous = pending;
    pending = Promise.withResolvers<ReadableStreamReadResult<VideoFrame>>();
    previous.resolve({ done: false, value: frame });
    return frame;
  };
  return { stream, track, readable, reader, stop, deliver, end: () => events.dispatchEvent(new Event("ended")), done: () => pending.resolve({ done: true, value: undefined }) };
}

function harness() {
  const listeners = new Set<(message: DesktopMediaMessage) => void>();
  const requests: Array<ReturnType<typeof Promise.withResolvers<DesktopMediaLease | null>>> = [];
  const requestMediaLease = vi.fn(() => {
    const pending = Promise.withResolvers<DesktopMediaLease | null>();
    requests.push(pending);
    return pending.promise;
  });
  const captures: Array<ReturnType<typeof source>> = [];
  const getUserMedia = vi.fn<MediaPainterDependencies["getUserMedia"]>(async () => {
    const capture = source();
    captures.push(capture);
    return capture.stream;
  });
  const createProcessor = vi.fn<MediaPainterDependencies["createProcessor"]>(({ track }) => ({
    readable: captures.find((item) => item.track === track)!.readable,
  }));
  const drawImage = vi.fn();
  const toBlob = vi.fn((callback: BlobCallback) => callback(new Blob([new Uint8Array([0xff, 0xd8, 7])])));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob } as unknown as HTMLCanvasElement;
  const onHeader = vi.fn();
  const painter = createMediaPainter(canvas, {
    requestMediaLease,
    onMediaMessage: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, "tab", onHeader, { getUserMedia, createProcessor });
  disposals.push(() => painter.dispose());
  const message = (value: DesktopMediaMessage): void => { for (const listener of listeners) listener(value); };
  const resize = (generation: number, size = geometry): void => message({ type: "media-geometry", tabId: "tab", generation, geometry: size });
  const open = async (): Promise<ReturnType<typeof source>> => {
    await settle();
    requests[0]!.resolve(lease());
    await settle();
    return captures[0]!;
  };
  return { painter, canvas, drawImage, toBlob, onHeader, requests, requestMediaLease, getUserMedia, createProcessor, captures, message, resize, open };
}

describe("local browser pane media painter", () => {
  it("captures exact even dimensions at 30 fps and crops matching frames without scaling", async () => {
    const h = harness();
    expect(await h.painter.jpeg()).toBeNull();
    const capture = await h.open();
    expect(h.getUserMedia).toHaveBeenCalledWith({ audio: false, video: { mandatory: {
      chromeMediaSource: "tab", chromeMediaSourceId: "source-1", minWidth: 2272, maxWidth: 2272,
      minHeight: 2006, maxHeight: 2006, maxFrameRate: 30,
    } } });
    expect(h.createProcessor).toHaveBeenCalledWith({ track: capture.track, maxBufferSize: 1 });
    const mismatch = capture.deliver(2270);
    await settle();
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(mismatch.close).toHaveBeenCalledOnce();
    const first = capture.deliver();
    await settle();
    expect(h.drawImage).toHaveBeenCalledWith(first, 0, 0, 2271, 2005, 0, 0, 2271, 2005);
    expect([h.canvas.width, h.canvas.height]).toEqual([2271, 2005]);
    expect(first.close).toHaveBeenCalledOnce();
    const second = capture.deliver();
    await settle();
    expect(h.onHeader.mock.calls).toEqual([[{ width: 2271, height: 2005, dsf: 1.5 }], [{ width: 2271, height: 2005, dsf: 1.5 }]]);
    expect(second.close).toHaveBeenCalledOnce();
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([0xff, 0xd8, 7]));
    expect(h.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.85);
  });

  it("changes logical crop and density without replacing an unchanged capture surface", async () => {
    const h = harness();
    const capture = await h.open();
    h.resize(1, { ...geometry, width: 2272, dsf: 2 });
    const frame = capture.deliver();
    await settle();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(1);
    expect(capture.stop).not.toHaveBeenCalled();
    expect(h.drawImage).toHaveBeenCalledWith(frame, 0, 0, 2272, 2005, 0, 0, 2272, 2005);
    expect(h.painter.header()).toEqual({ width: 2272, height: 2005, dsf: 2 });
  });

  it("re-leases once for a changed surface and closes superseded frames without painting", async () => {
    const h = harness();
    const first = await h.open();
    const resized = { ...geometry, width: 1001, surfaceWidth: 1002 };
    h.resize(1, resized);
    h.resize(1, resized);
    expect(h.requestMediaLease).toHaveBeenCalledTimes(2);
    expect(first.stop).toHaveBeenCalledOnce();
    const late = first.deliver();
    h.requests[1]!.resolve(lease(1, resized));
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(h.drawImage).not.toHaveBeenCalled();
    const frame = h.captures[1]!.deliver(1002);
    await settle();
    expect(h.drawImage).toHaveBeenCalledWith(frame, 0, 0, 1001, 2005, 0, 0, 1001, 2005);
    expect(frame.close).toHaveBeenCalledOnce();
  });

  it("waits for a newer generation after media-ended and ignores stale events and leases", async () => {
    const h = harness();
    const first = await h.open();
    h.message({ type: "media-ended", tabId: "other", generation: 99 });
    expect(first.stop).not.toHaveBeenCalled();
    h.message({ type: "media-ended", tabId: "tab", generation: 2 });
    const late = first.deliver();
    h.resize(1);
    h.resize(2);
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(1);
    h.resize(3);
    h.resize(3);
    h.resize(4);
    h.requests[1]!.resolve(lease(3));
    h.requests[2]!.resolve(lease(4));
    await settle();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.getUserMedia.mock.calls[1]![0].video.mandatory.chromeMediaSourceId).toBe("source-4");
  });

  it("does not retry an ended track until geometry or generation changes", async () => {
    const h = harness();
    const capture = await h.open();
    capture.end();
    const late = capture.deliver();
    h.resize(1);
    await settle();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(late.close).toHaveBeenCalledOnce();
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(1);
    h.resize(2);
    h.resize(2);
    expect(h.requestMediaLease).toHaveBeenCalledTimes(2);
  });

  it("waits after a null lease or capture rejection rather than polling", async () => {
    const h = harness();
    await settle();
    h.requests[0]!.resolve(null);
    await settle();
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(1);
    h.resize(1);
    h.getUserMedia.mockRejectedValueOnce(new Error("capture denied"));
    h.requests[1]!.resolve(lease());
    await settle();
    h.resize(1);
    await settle();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(2);
    h.resize(2);
    expect(h.requestMediaLease).toHaveBeenCalledTimes(3);
  });

  it("stops a capture that arrives after disposal without constructing a processor", async () => {
    const h = harness();
    const pending = Promise.withResolvers<MediaStream>();
    const capture = source();
    h.getUserMedia.mockReturnValueOnce(pending.promise);
    await settle();
    h.requests[0]!.resolve(lease());
    await settle();
    h.painter.dispose();
    pending.resolve(capture.stream);
    await settle();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(h.createProcessor).not.toHaveBeenCalled();
  });

  it("closes frames delivered after disposal exactly once and unsubscribes", async () => {
    const h = harness();
    const capture = await h.open();
    h.painter.dispose();
    h.painter.dispose();
    const late = capture.deliver();
    h.resize(2);
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.reader.cancel).toHaveBeenCalledOnce();
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(1);
    expect(await h.painter.jpeg()).toBeNull();
  });

  it("releases rejected canvas frames and still paints the next one", async () => {
    const h = harness();
    const capture = await h.open();
    h.drawImage.mockImplementationOnce(() => { throw new Error("lost context"); });
    const failed = capture.deliver();
    await settle();
    expect(failed.close).toHaveBeenCalledOnce();
    expect(h.painter.header()).toBeNull();
    const next = capture.deliver();
    await settle();
    expect(next.close).toHaveBeenCalledOnce();
    expect(h.painter.header()).toEqual({ width: 2271, height: 2005, dsf: 1.5 });
    capture.done();
    await settle();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(h.requestMediaLease).toHaveBeenCalledTimes(1);
  });
});
