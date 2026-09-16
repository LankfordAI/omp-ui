import { decodeBrowserPaneFrame, type BrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";

/**
 * Paints browser pane wire frames onto a canvas (issue #519, spec 6.4).
 * Latest wins: while one JPEG decodes, the newest arrival is parked and
 * decoded next; anything older is discarded — a slow decoder shows the
 * freshest page, never a backlog. The decoder is injectable because jsdom
 * has no `createImageBitmap`.
 */
export interface FramePainter {
  write(frame: Uint8Array): void;
  /** JPEG bytes (header stripped) of the last frame drawn; the attach button's source. */
  lastJpeg(): Uint8Array | null;
  header(): BrowserPaneFrameHeader | null;
  dispose(): void;
}

type Decoded = { header: BrowserPaneFrameHeader; jpeg: Uint8Array };

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
  let inflight = false;
  let parked: Decoded | null = null;
  let last: Decoded | null = null;
  let disposed = false;

  const paint = async (frame: Decoded): Promise<void> => {
    inflight = true;
    try {
      const bitmap = await decode(frame.jpeg);
      if (disposed) {
        bitmap.close();
        return;
      }
      const { header } = frame;
      if (canvas.width !== header.width || canvas.height !== header.height) {
        canvas.width = header.width;
        canvas.height = header.height;
        onHeader(header);
      } else if (last === null || last.header.dsf !== header.dsf) {
        onHeader(header);
      }
      ctx?.drawImage(bitmap, 0, 0);
      bitmap.close();
      last = frame;
    } catch {
      // A frame the decoder rejects is dropped; the next one repaints.
    } finally {
      inflight = false;
      const next = parked;
      parked = null;
      if (next !== null && !disposed) void paint(next);
    }
  };

  return {
    write(frame) {
      if (disposed) return;
      const decoded = decodeBrowserPaneFrame(frame);
      if (decoded === null) return;
      if (inflight) {
        parked = decoded;
        return;
      }
      void paint(decoded);
    },
    lastJpeg() {
      return last?.jpeg ?? null;
    },
    header() {
      return last?.header ?? null;
    },
    dispose() {
      disposed = true;
      parked = null;
    },
  };
}
