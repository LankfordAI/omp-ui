import { describe, expect, it, vi } from "vitest";
import { encodeBrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";
import { createFramePainter } from "./browser-pane-frame";

function frame(marker: number): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes.set(encodeBrowserPaneFrameHeader({ width: 1280, height: 800, dsf: 1 }));
  bytes[8] = marker;
  return bytes;
}

function harness() {
  const drawImage = vi.fn();
  const onHeader = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
  const decodes: Array<{
    marker: number;
    resolve: (bitmap: ImageBitmap) => void;
    reject: (reason: Error) => void;
  }> = [];
  const painter = createFramePainter(canvas, onHeader, (jpeg) => {
    const { promise, resolve, reject } = Promise.withResolvers<ImageBitmap>();
    decodes.push({ marker: jpeg[0]!, resolve, reject });
    return promise;
  });
  const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
  return { painter, decodes, canvas, drawImage, onHeader, bitmap };
}

describe("browser pane frame completion", () => {
  it("holds completion until the decoded frame is drawn", async () => {
    const h = harness();
    let settled = false;
    const painted = h.painter.write(frame(1)).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.drawImage).not.toHaveBeenCalled();
    const bitmap = h.bitmap();
    h.decodes[0]!.resolve(bitmap);
    await painted;
    expect(h.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(h.painter.lastJpeg()).toEqual(new Uint8Array([1]));
    expect(h.painter.header()).toEqual({ width: 1280, height: 800, dsf: 1 });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("settles replaced parked writes without decoding them and paints only the newest next", async () => {
    const h = harness();
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
    expect(h.painter.lastJpeg()).toEqual(new Uint8Array([3]));
    expect(h.drawImage).toHaveBeenCalledTimes(2);
  });

  it("disposal settles decoding and parked writes immediately, then closes late bitmaps without painting", async () => {
    const h = harness();
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
    expect(h.painter.lastJpeg()).toBeNull();
  });

  it("settles invalid bytes and decode failure without starving the next valid frame", async () => {
    const h = harness();
    await h.painter.write(new Uint8Array([0]));
    expect(h.decodes).toEqual([]);
    const failed = h.painter.write(frame(1));
    const next = h.painter.write(frame(2));
    h.decodes[0]!.reject(new Error("invalid JPEG"));
    await failed;
    expect(h.decodes.map((entry) => entry.marker)).toEqual([1, 2]);
    h.decodes[1]!.resolve(h.bitmap());
    await next;
    expect(h.painter.lastJpeg()).toEqual(new Uint8Array([2]));
    expect(h.drawImage).toHaveBeenCalledTimes(1);
  });

  it("drops canvas failures, releases the bitmap and continues with the next frame", async () => {
    const h = harness();
    h.drawImage.mockImplementationOnce(() => { throw new Error("lost canvas"); });
    const failed = h.painter.write(frame(1));
    const next = h.painter.write(frame(2));
    const bitmap = h.bitmap();
    h.decodes[0]!.resolve(bitmap);
    await failed;
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.painter.lastJpeg()).toBeNull();
    h.decodes[1]!.resolve(h.bitmap());
    await next;
    expect(h.painter.lastJpeg()).toEqual(new Uint8Array([2]));
  });

  it("intentionally drops frames when the canvas has no drawing context", async () => {
    const decode = vi.fn();
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    const painter = createFramePainter(canvas, () => {}, decode);
    await painter.write(frame(1));
    expect(decode).not.toHaveBeenCalled();
    expect(painter.lastJpeg()).toBeNull();
  });
});