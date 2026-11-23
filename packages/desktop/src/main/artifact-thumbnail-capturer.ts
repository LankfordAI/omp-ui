import { BrowserWindow, type NativeImage } from "electron";
import { ARTIFACT_LIMITS, composeHtmlArtifactDocument, htmlArtifactDataUrl } from "@omp-ui/core";
import { ARTIFACT_GUEST_PREFERENCES, confineGuest, isArtifactSessionLocked } from "./html-artifact-guard";

const THUMB_WIDTH = 640;
const THUMB_HEIGHT = 400;
const THUMB_ASPECT = THUMB_WIDTH / THUMB_HEIGHT;
const PNG_SOFT_LIMIT = 64 * 1024;
const CAPTURE_SETTLE_MS = 200;
const CAPTURE_TIMEOUT_MS = 4_000;

export interface EncodedArtifactThumbnail {
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

/**
 * Normalizes a captured Electron NativeImage to a top-aligned 16:10 640x400
 * raster thumbnail bounded by ARTIFACT_LIMITS.thumbnailBytes.
 */
export function encodeArtifactThumbnail(image: NativeImage): EncodedArtifactThumbnail | null {
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return null;

  let cropped = image;
  const aspect = size.width / size.height;
  if (aspect > THUMB_ASPECT) {
    const cropWidth = Math.max(1, Math.round(size.height * THUMB_ASPECT));
    const x = Math.max(0, Math.floor((size.width - cropWidth) / 2));
    cropped = image.crop({ x, y: 0, width: Math.min(cropWidth, size.width - x), height: size.height });
  } else if (aspect < THUMB_ASPECT) {
    const cropHeight = Math.max(1, Math.round(size.width / THUMB_ASPECT));
    cropped = image.crop({ x: 0, y: 0, width: size.width, height: Math.min(cropHeight, size.height) });
  }

  const resized = cropped.resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, quality: "good" });
  const png = resized.toPNG();
  if (png.byteLength > 0 && png.byteLength <= PNG_SOFT_LIMIT) {
    return { mime: "image/png", bytes: new Uint8Array(png.buffer, png.byteOffset, png.byteLength) };
  }
  const jpg = resized.toJPEG(82);
  if (jpg.byteLength > 0 && jpg.byteLength <= ARTIFACT_LIMITS.thumbnailBytes) {
    return { mime: "image/jpeg", bytes: new Uint8Array(jpg.buffer, jpg.byteOffset, jpg.byteLength) };
  }
  if (png.byteLength > 0 && png.byteLength <= ARTIFACT_LIMITS.thumbnailBytes) {
    return { mime: "image/png", bytes: new Uint8Array(png.buffer, png.byteOffset, png.byteLength) };
  }
  return null;
}

export interface DocumentThumbnailSource {
  artifactId: string;
  codeRevisionId: string;
  dataSnapshotId: string;
  html: string;
  scripts: boolean;
}

export interface ArtifactThumbnailCapturerService {
  readonly enabled: boolean;
  readDocumentForThumbnail(artifactId: string): DocumentThumbnailSource | null;
  saveThumbnail(request: {
    artifactId: string;
    codeRevisionId: string;
    dataSnapshotId: string;
    dark: boolean;
    mime: "image/png" | "image/jpeg";
    bytes: Uint8Array;
  }): { hash: string } | null;
}

interface CaptureJob {
  key: string;
  artifactId: string;
  themeCss: string;
  dark: boolean;
  resolve: (value: { hash: string } | null) => void;
}

/**
 * Serialized offscreen capturer for document-only artifacts (ADR-0082 amendment).
 * Fail-closed: never creates a BrowserWindow unless `isArtifactSessionLocked()` is true.
 */
export class ArtifactThumbnailCapturer {
  private readonly queue: CaptureJob[] = [];
  private readonly pending = new Map<string, Promise<{ hash: string } | null>>();
  private activeWindow: BrowserWindow | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly service: () => ArtifactThumbnailCapturerService,
    private readonly isLocked: () => boolean = isArtifactSessionLocked,
  ) {}

  ensure(artifactId: string, themeCss: string, dark: boolean): Promise<{ hash: string } | null> {
    if (this.disposed || !this.isLocked() || !this.service().enabled) return Promise.resolve(null);
    const key = `${artifactId}:${dark ? "dark" : "light"}`;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const { promise, resolve } = Promise.withResolvers<{ hash: string } | null>();
    this.queue.push({ key, artifactId, themeCss, dark, resolve });
    if (!this.running) void this.drain();
    this.pending.set(key, promise);
    void promise.finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    return promise;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        if (this.disposed) {
          job.resolve(null);
          continue;
        }
        try {
          job.resolve(await this.captureOne(job));
        } catch {
          job.resolve(null);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async captureOne(job: CaptureJob): Promise<{ hash: string } | null> {
    if (this.disposed || !this.isLocked()) return null;
    const svc = this.service();
    if (!svc.enabled) return null;

    let doc: DocumentThumbnailSource | null;
    try {
      doc = svc.readDocumentForThumbnail(job.artifactId);
    } catch {
      return null;
    }
    if (!doc) return null;

    const url = htmlArtifactDataUrl(composeHtmlArtifactDocument(doc.html, job.themeCss, doc.scripts));
    if (!this.isLocked() || this.disposed || !svc.enabled) return null;

    const win = new BrowserWindow({
      show: false,
      width: 960,
      height: 600,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        ...ARTIFACT_GUEST_PREFERENCES,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    this.activeWindow = win;
    try {
      win.setMenuBarVisibility(false);
      confineGuest(win.webContents);

      const { promise: paintedPromise, resolve: resolvePainted } = Promise.withResolvers<boolean>();
      let finished = false;
      let finishLoaded = false;
      let sawPaint = false;
      let settleTimer: NodeJS.Timeout | undefined;
      const done = (ok: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(hardTimer);
        clearTimeout(settleTimer);
        if (!win.isDestroyed()) {
          win.webContents.removeListener("did-finish-load", onFinishLoad);
          win.webContents.removeListener("paint", onPaint);
          win.webContents.removeListener("did-fail-load", onFail);
          win.webContents.removeListener("render-process-gone", onFail);
        }
        resolvePainted(ok);
      };
      const maybeSettle = (): void => {
        if (!finishLoaded || !sawPaint || settleTimer !== undefined) return;
        settleTimer = setTimeout(() => done(true), CAPTURE_SETTLE_MS);
      };
      const onFinishLoad = (): void => {
        finishLoaded = true;
        if (!win.isDestroyed()) win.webContents.invalidate();
        maybeSettle();
      };
      const onPaint = (): void => {
        sawPaint = true;
        maybeSettle();
      };
      const onFail = (): void => done(false);
      const hardTimer = setTimeout(() => done(finishLoaded), CAPTURE_TIMEOUT_MS);

      win.webContents.once("did-finish-load", onFinishLoad);
      win.webContents.on("paint", onPaint);
      win.webContents.once("did-fail-load", onFail);
      win.webContents.once("render-process-gone", onFail);
      void win.loadURL(url).catch(() => done(false));
      const painted = await paintedPromise;

      if (!painted || this.disposed || win.isDestroyed() || !svc.enabled) return null;
      const image = await win.webContents.capturePage();
      const encoded = encodeArtifactThumbnail(image);
      if (!encoded || this.disposed || !svc.enabled) return null;

      return svc.saveThumbnail({
        artifactId: doc.artifactId,
        codeRevisionId: doc.codeRevisionId,
        dataSnapshotId: doc.dataSnapshotId,
        dark: job.dark,
        mime: encoded.mime,
        bytes: encoded.bytes,
      });
    } finally {
      if (this.activeWindow === win) this.activeWindow = null;
      if (!win.isDestroyed()) win.destroy();
    }
  }

  dispose(): void {
    this.disposed = true;
    while (this.queue.length > 0) this.queue.shift()!.resolve(null);
    if (this.activeWindow && !this.activeWindow.isDestroyed()) {
      this.activeWindow.destroy();
    }
    this.activeWindow = null;
  }
}
