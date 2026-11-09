import { describe, expect, it, vi } from "vitest";
import { decodeBrowserPaneFrame, encodeBrowserPaneFrameHeader, type BrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";
import { decodeDevicePaneFrame, encodeDevicePaneFrameHeader, type DevicePaneFrameHeader } from "@omp-ui/core/device-pane";
import { createFramePainter } from "./browser-pane-frame";

function frame(marker: number): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes.set(encodeBrowserPaneFrameHeader({ width: 1280, height: 800, dsf: 1 }));
  bytes[8] = marker;
  return bytes;
}

const BINDING = "12345678-1234-4123-8123-123456789abc";
const NEXT_BINDING = "87654321-4321-4321-8321-cba987654321";

function deviceFrame(header: DevicePaneFrameHeader, marker: number): Uint8Array {
  const encoded = encodeDevicePaneFrameHeader(header);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  bytes[encoded.length] = marker;
  return bytes;
}


function harness<H extends BrowserPaneFrameHeader>(
  decodeFrame: (bytes: Uint8Array) => { header: H; jpeg: Uint8Array } | null,
  isCurrent?: (header: H) => boolean,
) {
  const drawImage = vi.fn();
  const onHeader = vi.fn<(header: H) => void>();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
  const decodes: Array<{
    marker: number;
    resolve: (bitmap: ImageBitmap) => void;
    reject: (reason: Error) => void;
  }> = [];
  const painter = createFramePainter(canvas, onHeader, decodeFrame, (jpeg) => {
    const { promise, resolve, reject } = Promise.withResolvers<ImageBitmap>();
    decodes.push({ marker: jpeg[0]!, resolve, reject });
    return promise;
  }, isCurrent);
  const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
  return { painter, decodes, canvas, drawImage, onHeader, bitmap };
}

describe("browser pane frame completion", () => {
  it("holds completion until the decoded frame is drawn", async () => {
    const h = harness(decodeBrowserPaneFrame);
    let settled = false;
    const painted = h.painter.write(frame(1)).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.onHeader).not.toHaveBeenCalled();
    const bitmap = h.bitmap();
    h.decodes[0]!.resolve(bitmap);
    await painted;
    expect(h.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(h.onHeader).toHaveBeenCalledWith({ width: 1280, height: 800, dsf: 1 });
    expect(h.drawImage.mock.invocationCallOrder[0]).toBeLessThan(h.onHeader.mock.invocationCallOrder[0]!);
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([1]));
    expect(h.painter.header()).toEqual({ width: 1280, height: 800, dsf: 1 });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("restores attachment readiness after metadata is cleared at unchanged dimensions", async () => {
    const h = harness(decodeBrowserPaneFrame);
    let attachmentReady = false;
    h.onHeader.mockImplementation(() => { attachmentReady = true; });
    const first = h.painter.write(frame(1));
    h.decodes[0]!.resolve(h.bitmap());
    await first;
    expect(attachmentReady).toBe(true);

    // The store invalidates metadata when clear-data recreates the host page.
    attachmentReady = false;
    const recreated = h.painter.write(frame(2));
    h.decodes[1]!.resolve(h.bitmap());
    await recreated;
    expect(attachmentReady).toBe(true);
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([2]));
  });

  it("settles replaced parked writes without decoding them and paints only the newest next", async () => {
    const h = harness(decodeBrowserPaneFrame);
    const first = h.painter.write(frame(1));
    const superseded = h.painter.write(frame(2));
    let latestSettled = false;
    const latest = h.painter.write(frame(3)).then(() => { latestSettled = true; });
    await superseded;
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1]);
    expect(latestSettled).toBe(false);
    h.decodes[0]!.resolve(h.bitmap());
    await first;
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1, 3]);
    expect(latestSettled).toBe(false);
    h.decodes[1]!.resolve(h.bitmap());
    await latest;
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([3]));
    expect(h.drawImage).toHaveBeenCalledTimes(2);
  });

  it("disposal settles decoding and parked writes immediately, then closes late bitmaps without painting", async () => {
    const h = harness(decodeBrowserPaneFrame);
    const first = h.painter.write(frame(1));
    const parked = h.painter.write(frame(2));
    h.painter.dispose();
    await Promise.all([first, parked, h.painter.write(frame(3))]);
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1]);
    const bitmap = h.bitmap();
    h.decodes[0]!.resolve(bitmap);
    await Promise.resolve();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.onHeader).not.toHaveBeenCalled();
    expect(await h.painter.jpeg()).toBeNull();
  });

  it("settles invalid bytes and decode failure without starving the next valid frame", async () => {
    const h = harness(decodeBrowserPaneFrame);
    await h.painter.write(new Uint8Array([0]));
    expect(h.decodes).toEqual([]);
    const failed = h.painter.write(frame(1));
    const next = h.painter.write(frame(2));
    h.decodes[0]!.reject(new Error("invalid JPEG"));
    await failed;
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1, 2]);
    h.decodes[1]!.resolve(h.bitmap());
    await next;
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([2]));
    expect(h.drawImage).toHaveBeenCalledTimes(1);
  });

  it("drops canvas failures, releases the bitmap and continues with the next frame", async () => {
    const h = harness(decodeBrowserPaneFrame);
    h.drawImage.mockImplementationOnce(() => { throw new Error("lost canvas"); });
    const failed = h.painter.write(frame(1));
    const next = h.painter.write(frame(2));
    const bitmap = h.bitmap();
    h.decodes[0]!.resolve(bitmap);
    await failed;
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(await h.painter.jpeg()).toBeNull();
    expect(h.onHeader).not.toHaveBeenCalled();
    expect(h.painter.header()).toBeNull();
    h.decodes[1]!.resolve(h.bitmap());
    await next;
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([2]));
  });

  it("settles a rejected frame-header decode without starting JPEG decoding", async () => {
    const decodeFrame = vi.fn(decodeBrowserPaneFrame);
    decodeFrame.mockImplementationOnce(() => { throw new Error("invalid frame header"); });
    const h = harness(decodeFrame);
    await h.painter.write(frame(1));
    expect(h.decodes).toEqual([]);
    expect(h.onHeader).not.toHaveBeenCalled();
    const next = h.painter.write(frame(2));
    const bitmap = h.bitmap();
    h.decodes[0]!.resolve(bitmap);
    await next;
    expect(h.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("intentionally drops frames when the canvas has no drawing context", async () => {
    const decode = vi.fn();
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    const painter = createFramePainter(canvas, () => {}, decodeBrowserPaneFrame, decode);
    await painter.write(frame(1));
    expect(decode).not.toHaveBeenCalled();
    expect(await painter.jpeg()).toBeNull();
  });
});

describe("bound pane frame completion", () => {
  const initial: DevicePaneFrameHeader = {
    width: 1280,
    height: 800,
    dsf: 1,
    bindingId: BINDING,
    geometryRevision: 1,
  };

  it("drops stale deliveries before JPEG decoding without replacing the queued current frame", async () => {
    const h = harness(decodeDevicePaneFrame, (header) =>
      header.bindingId === BINDING && header.geometryRevision === 1);
    const first = h.painter.write(deviceFrame(initial, 1));
    const parked = h.painter.write(deviceFrame(initial, 2));
    await Promise.all([
      h.painter.write(deviceFrame({ ...initial, bindingId: NEXT_BINDING }, 3)),
      h.painter.write(deviceFrame({ ...initial, geometryRevision: 2 }, 4)),
      h.painter.write(frame(5)),
    ]);
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1]);
    const firstBitmap = h.bitmap();
    h.decodes[0]!.resolve(firstBitmap);
    await first;
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1, 2]);
    const latestBitmap = h.bitmap();
    h.decodes[1]!.resolve(latestBitmap);
    await parked;
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([2]));
    expect(h.painter.header()?.bindingId).toBe(BINDING);
    expect(h.onHeader).toHaveBeenCalledTimes(2);
    expect(firstBitmap.close).toHaveBeenCalledTimes(1);
    expect(latestBitmap.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["binding", NEXT_BINDING, 1],
    ["geometry", BINDING, 2],
  ] as const)("cannot paint a slow old decode after the %s changes at identical dimensions", async (_change, bindingId, geometryRevision) => {
    let current = initial;
    const h = harness(decodeDevicePaneFrame, (header) =>
      header.bindingId === current.bindingId && header.geometryRevision === current.geometryRevision);
    const old = h.painter.write(deviceFrame(initial, 1));
    current = { ...initial, bindingId, geometryRevision };
    const latest = h.painter.write(deviceFrame(current, 2));
    const oldBitmap = h.bitmap();
    h.decodes[0]!.resolve(oldBitmap);
    await old;
    expect(oldBitmap.close).toHaveBeenCalledTimes(1);
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.onHeader).not.toHaveBeenCalled();
    expect(h.canvas.width).toBe(0);
    expect(h.canvas.height).toBe(0);
    expect(h.painter.header()).toBeNull();
    expect(await h.painter.jpeg()).toBeNull();
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1, 2]);
    const latestBitmap = h.bitmap();
    h.decodes[1]!.resolve(latestBitmap);
    await latest;
    expect(h.drawImage).toHaveBeenCalledExactlyOnceWith(latestBitmap, 0, 0);
    expect(h.onHeader).toHaveBeenCalledExactlyOnceWith(current);
    expect(h.painter.header()).toEqual(current);
    expect(await h.painter.jpeg()).toEqual(new Uint8Array([2]));
    expect(latestBitmap.close).toHaveBeenCalledTimes(1);
  });

  it("settles a parked frame that becomes stale before decoding and accepts the next geometry", async () => {
    let geometryRevision = 1;
    const h = harness(decodeDevicePaneFrame, (header) =>
      header.bindingId === BINDING && header.geometryRevision === geometryRevision);
    const first = h.painter.write(deviceFrame(initial, 1));
    const parked = h.painter.write(deviceFrame(initial, 2));
    geometryRevision = 2;
    const oldBitmap = h.bitmap();
    h.decodes[0]!.resolve(oldBitmap);
    await Promise.all([first, parked]);
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1]);
    expect(oldBitmap.close).toHaveBeenCalledTimes(1);
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.onHeader).not.toHaveBeenCalled();
    const current = { ...initial, geometryRevision };
    const next = h.painter.write(deviceFrame(current, 3));
    const bitmap = h.bitmap();
    h.decodes[1]!.resolve(bitmap);
    await next;
    expect(h.onHeader).toHaveBeenCalledExactlyOnceWith(current);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});