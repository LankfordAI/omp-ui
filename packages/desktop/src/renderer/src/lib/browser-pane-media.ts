import type { BrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";
import type { DesktopMediaGeometry, DesktopMediaLease } from "../../../browser-pane-desktop-protocol";
import type { DesktopPaneMedia } from "./browser-pane-desktop-stream";
import type { PanePainter } from "./browser-pane-frame";

interface TabCaptureConstraints extends MediaStreamConstraints {
  audio: false;
  video: MediaTrackConstraints & {
    mandatory: {
      chromeMediaSource: "tab";
      chromeMediaSourceId: string;
      minWidth: number;
      maxWidth: number;
      minHeight: number;
      maxHeight: number;
      maxFrameRate: 30;
    };
  };
}

export interface MediaPainterDependencies {
  getUserMedia(constraints: TabCaptureConstraints): Promise<MediaStream>;
  createProcessor(options: { track: MediaStreamTrack; maxBufferSize: 1 }): {
    readable: ReadableStream<VideoFrame>;
  };
}

const browserDependencies: MediaPainterDependencies = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createProcessor: (options) => {
    // Chromium exposes this constructor in Window, but lib.dom does not yet declare it.
    const { MediaStreamTrackProcessor } = globalThis as unknown as {
      MediaStreamTrackProcessor: new (options: { track: MediaStreamTrack; maxBufferSize: 1 }) => {
        readable: ReadableStream<VideoFrame>;
      };
    };
    return new MediaStreamTrackProcessor(options);
  },
};

type GeometryVersion = Pick<DesktopMediaLease, "generation" | "geometry">;
type Capture = {
  stream: MediaStream;
  track: MediaStreamTrack;
  reader: ReadableStreamDefaultReader<VideoFrame> | null;
  geometry: DesktopMediaGeometry;
  ended: () => void;
  stopped: boolean;
};

function sameGeometry(a: DesktopMediaGeometry, b: DesktopMediaGeometry): boolean {
  return a.width === b.width && a.height === b.height && a.dsf === b.dsf &&
    a.surfaceWidth === b.surfaceWidth && a.surfaceHeight === b.surfaceHeight;
}

/** Captures the local page at compositor density; only the logical, unpadded pixels reach the canvas. */
export function createMediaPainter(
  canvas: HTMLCanvasElement,
  media: DesktopPaneMedia,
  tabId: string,
  onHeader: (header: BrowserPaneFrameHeader) => void,
  deps: MediaPainterDependencies = browserDependencies,
): PanePainter {
  const ctx = canvas.getContext("2d");
  let disposed = false;
  let epoch = 0;
  let latest: GeometryVersion | null = null;
  let endedGeneration = -1;
  let capture: Capture | null = null;
  let header: BrowserPaneFrameHeader | null = null;

  const stop = (session: Capture): void => {
    if (session.stopped) return;
    session.stopped = true;
    session.track.removeEventListener("ended", session.ended);
    for (const track of session.stream.getTracks()) track.stop();
    void session.reader?.cancel().catch(() => {});
    if (capture === session) capture = null;
  };
  const invalidate = (): number => {
    ++epoch;
    if (capture !== null) stop(capture);
    return epoch;
  };
  const start = async (ticket: number): Promise<void> => {
    let session: Capture | null = null;
    try {
      const lease = await media.requestMediaLease(tabId);
      if (disposed || epoch !== ticket || lease === null || lease.generation <= endedGeneration || ctx === null) return;
      latest = { generation: lease.generation, geometry: lease.geometry };
      const { surfaceWidth, surfaceHeight } = lease.geometry;
      const stream = await deps.getUserMedia({
        audio: false,
        video: { mandatory: {
          chromeMediaSource: "tab", chromeMediaSourceId: lease.sourceId,
          minWidth: surfaceWidth, maxWidth: surfaceWidth,
          minHeight: surfaceHeight, maxHeight: surfaceHeight, maxFrameRate: 30,
        } },
      });
      const track = stream.getVideoTracks()[0];
      if (disposed || epoch !== ticket || track === undefined) {
        for (const item of stream.getTracks()) item.stop();
        return;
      }
      session = {
        stream, track, reader: null, geometry: lease.geometry, stopped: false,
        ended: () => { if (epoch === ticket) invalidate(); },
      };
      capture = session;
      track.addEventListener("ended", session.ended, { once: true });
      if (track.readyState === "ended") return;
      const reader = deps.createProcessor({ track, maxBufferSize: 1 }).readable.getReader();
      session.reader = reader;
      while (!disposed && epoch === ticket) {
        const { done, value: frame } = await reader.read();
        try {
          if (done || disposed || epoch !== ticket) break;
          const geometry = session.geometry;
          if (frame.displayWidth !== geometry.surfaceWidth || frame.displayHeight !== geometry.surfaceHeight) continue;
          const { width, height, dsf } = geometry;
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          ctx.drawImage(frame, 0, 0, width, height, 0, 0, width, height);
          header = { width, height, dsf };
          onHeader(header);
        } catch {
          // A rejected canvas frame does not stall subsequent capture frames.
        } finally {
          frame?.close();
        }
      }
    } catch {
      // No polling or fallback JPEG capture. A newer page/geometry permits one new lease.
    } finally {
      if (session !== null) {
        stop(session);
        session.reader?.releaseLock();
      }
    }
  };
  const unsubscribe = media.onMediaMessage((message) => {
    if (disposed || message.tabId !== tabId || message.type === "media-lease") return;
    if (message.type === "media-ended") {
      if (message.generation < (latest?.generation ?? -1) || message.generation <= endedGeneration) return;
      endedGeneration = message.generation;
      invalidate();
      return;
    }
    if (message.generation <= endedGeneration || message.generation < (latest?.generation ?? -1)) return;
    if (latest?.generation === message.generation) {
      if (sameGeometry(latest.geometry, message.geometry)) return;
      const sameSurface = latest.geometry.surfaceWidth === message.geometry.surfaceWidth &&
        latest.geometry.surfaceHeight === message.geometry.surfaceHeight;
      latest = { generation: message.generation, geometry: message.geometry };
      if (sameSurface && capture !== null) {
        capture.geometry = message.geometry;
        return;
      }
    } else {
      latest = { generation: message.generation, geometry: message.geometry };
    }
    void start(invalidate());
  });
  // Let the pane's subscription effect run before asking main for its first lease.
  const initialTicket = epoch;
  void Promise.resolve().then(() => {
    if (!disposed && epoch === initialTicket && ctx !== null) return start(initialTicket);
  });

  return {
    header: () => header,
    async jpeg() {
      if (disposed || header === null) return null;
      const { promise, resolve } = Promise.withResolvers<Blob | null>();
      canvas.toBlob(resolve, "image/jpeg", 0.85);
      const blob = await promise;
      return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      invalidate();
    },
  };
}
