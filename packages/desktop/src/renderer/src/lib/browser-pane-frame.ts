import { decodeBrowserPaneFrame, type BrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";

/**
 * Paints browser pane wire frames onto a canvas (issue #519, spec 6.4).
 * Latest wins: while one JPEG decodes, the newest arrival is parked and
 * decoded next; anything older is discarded — a slow decoder shows the
 * freshest page, never a backlog. The decoder is injectable because jsdom
 * has no `createImageBitmap`.
 */
export interface FramePainter {
  /** Settles after drawing or intentionally dropping this delivery. */
  write(frame: Uint8Array): Promise<void>;
  /** JPEG bytes (header stripped) of the last frame drawn; the attach button's source. */
  lastJpeg(): Uint8Array | null;
  header(): BrowserPaneFrameHeader | null;
  dispose(): void;
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
        onHeader(header);
      } else if (last === null || last.header.dsf !== header.dsf) {
        onHeader(header);
      }
      ctx?.drawImage(bitmap, 0, 0);
      last = frame;
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
    lastJpeg() {
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
