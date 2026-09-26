import { decodeBrowserPaneFrame, type BrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";

/** A canvas-backed browser pane image, supplied by local media or remote JPEG frames. */
export interface PanePainter {
  /** JPEG bytes of the last frame drawn; the attach button's source. */
  jpeg(): Promise<Uint8Array | null>;
  header(): BrowserPaneFrameHeader | null;
  dispose(): void;
}

/** Latest JPEG wins: while one decodes, only the newest arrival waits for the decoder. */
export interface FramePainter extends PanePainter {
  /** Settles after drawing or intentionally dropping this delivery. */
  write(frame: Uint8Array): Promise<void>;
}

type Decoded = { header: BrowserPaneFrameHeader; jpeg: Uint8Array };
type Pending = { frame: Decoded; settle: () => void };

function decodeJpeg(jpeg: Uint8Array): Promise<ImageBitmap> {
  // A Blob over a view takes the view's bytes only, so the header-stripped
  // subarray needs no copy. The frame arrives over IPC on a plain
  // ArrayBuffer; lib.dom's BlobPart just cannot see that from the view type.
  return createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
}

export function createFramePainter(
  canvas: HTMLCanvasElement,
  onHeader: (header: BrowserPaneFrameHeader) => void,
  decode: (jpeg: Uint8Array) => Promise<ImageBitmap> = decodeJpeg,
): FramePainter {
  const ctx = canvas.getContext("2d");
  let inflight: Pending | null = null;
  let parked: Pending | null = null;
  let last: Decoded | null = null;
  let disposed = false;

  const paint = async (entry: Pending): Promise<void> => {
    inflight = entry;
    let bitmap: ImageBitmap | null = null;
    try {
      const { frame } = entry;
      bitmap = await decode(frame.jpeg);
      if (disposed) return;
      const { header } = frame;
      if (canvas.width !== header.width || canvas.height !== header.height) {
        canvas.width = header.width;
        canvas.height = header.height;
      }
      ctx?.drawImage(bitmap, 0, 0);
      last = frame;
      // Clear-data recreation can reset the consumer while this painter survives
      // with the same canvas dimensions. The store suppresses unchanged metadata.
      onHeader(header);
    } catch {
      // A frame the decoder or canvas rejects is dropped; the next one repaints.
    } finally {
      bitmap?.close();
      entry.settle();
      inflight = null;
      const next = parked;
      parked = null;
      if (next !== null && !disposed) void paint(next);
    }
  };

  return {
    write(frame) {
      if (disposed || ctx === null) return Promise.resolve();
      const decoded = decodeBrowserPaneFrame(frame);
      if (decoded === null) return Promise.resolve();
      return new Promise<void>((settle) => {
        const entry = { frame: decoded, settle };
        if (inflight !== null) {
          parked?.settle();
          parked = entry;
        } else {
          void paint(entry);
        }
      });
    },
    async jpeg() {
      return last?.jpeg ?? null;
    },
    header() {
      return last?.header ?? null;
    },
    dispose() {
      disposed = true;
      inflight?.settle();
      parked?.settle();
      parked = null;
    },
  };
}

/** Cuts a padded viewport rect from the painted physical-pixel canvas as JPEG bytes. */
export async function cropFrame(
  canvas: HTMLCanvasElement,
  header: BrowserPaneFrameHeader,
  rect: { x: number; y: number; width: number; height: number },
  padCss = 16,
  quality = 0.85,
): Promise<Uint8Array | null> {
  if (canvas.width === 0 || canvas.height === 0) return null;
  const left = Math.max(0, Math.floor((rect.x - padCss) * header.dsf));
  const top = Math.max(0, Math.floor((rect.y - padCss) * header.dsf));
  const right = Math.min(canvas.width, Math.ceil((rect.x + rect.width + padCss) * header.dsf));
  const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.height + padCss) * header.dsf));
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return null;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(canvas, left, top, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", quality));
  return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
}
