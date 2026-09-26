import type { PaneDebugger } from "./browser-pane-contents";

export interface CapturedPaneFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  processMs: number;
}

/** Locate only the bounded JPEG header, never entropy-coded scan data. */
function jpegSof(jpeg: Buffer): { width: number; height: number; offset: number; components: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const end = Math.min(jpeg.length, 65536);
  let offset = 2;
  while (offset < end) {
    if (jpeg[offset++] !== 0xff) return null;
    while (offset < end && jpeg[offset] === 0xff) offset += 1;
    if (offset >= end) return null;
    const marker = jpeg[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0 || marker === 0xd8) return null;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > end) return null;
    const length = jpeg.readUInt16BE(offset);
    if (length < 2 || offset + length > end) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return null;
      const components = jpeg[offset + 7];
      if (!components || length !== 8 + 3 * components) return null;
      const height = jpeg.readUInt16BE(offset + 3);
      const width = jpeg.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height, offset, components } : null;
    }
    offset += length;
  }
  return null;
}

export function jpegDimensions(jpeg: Buffer): { width: number; height: number } | null {
  const sof = jpegSof(jpeg);
  return sof === null ? null : { width: sof.width, height: sof.height };
}

/** Remove at most one padded trailing pixel per axis without changing the JPEG block grid.
 * Mutates the capture-owned buffer so fan-out still needs only one frame allocation. */
export function trimJpegToWidthHeight(jpeg: Buffer, width: number, height: number): Buffer | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const sof = jpegSof(jpeg);
  if (sof === null || jpeg[sof.offset + 2] !== 8) return null;
  if ((width !== sof.width && (sof.width - width !== 1 || width % 2 !== 1)) ||
    (height !== sof.height && (sof.height - height !== 1 || height % 2 !== 1))) return null;
  for (let component = 0; component < sof.components; component += 1) {
    const sampling = jpeg[sof.offset + 9 + component * 3]!;
    const horizontal = sampling >> 4;
    const vertical = sampling & 15;
    if (horizontal < 1 || horizontal > 2 || vertical < 1 || vertical > 2) return null;
  }
  jpeg.writeUInt16BE(height, sof.offset + 3);
  jpeg.writeUInt16BE(width, sof.offset + 5);
  return jpeg;
}

export interface BrowserPaneCaptureOptions {
  fps: number;
  quality: number;
  onFrame: (frame: CapturedPaneFrame) => void;
  onError: (error: Error) => void;
}

export interface BrowserPaneCapture {
  setEnabled(enabled: boolean): void;
  setQuality(quality: number): void;
  dispose(): void;
}

interface EncodedFrame {
  data: string;
  token: unknown;
  session: string;
  generation: number;
}

export function createBrowserPaneCapture(debugger_: PaneDebugger, options: BrowserPaneCaptureOptions): BrowserPaneCapture {
  return new PrivatePaneCapture(debugger_, options);
}

/** A private flattened page session, independent of every agent-owned session. */
class PrivatePaneCapture implements BrowserPaneCapture {
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private quality: number;
  private session: string | null = null;
  private sessionGeneration = 0;
  private readonly owned = new Set<string>();
  private listening = false;
  private serial = Promise.resolve();
  private pending: EncodedFrame | null = null;
  private timer: NodeJS.Timeout | undefined;
  private lastPublished: number | null = null;

  constructor(private readonly debugger_: PaneDebugger, private readonly options: BrowserPaneCaptureOptions) {
    this.quality = options.quality;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    this.reconfigure();
  }

  setQuality(quality: number): void {
    if (this.disposed || quality === this.quality) return;
    this.quality = quality;
    this.reconfigure();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.reconfigure();
    void this.serial.finally(() => this.releaseListeners()).catch(() => {});
  }

  private releaseListeners(): void {
    if (!this.listening) return;
    this.listening = false;
    this.debugger_.off("message", this.onMessage);
    this.debugger_.off("detach", this.onDetach);
    this.owned.clear();
  }

  private fence(): number {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) this.ack(pending);
    return this.generation;
  }

  private reconfigure(): void {
    const generation = this.fence();
    if (this.enabled && !this.listening) {
      this.listening = true;
      this.debugger_.on("message", this.onMessage);
      this.debugger_.on("detach", this.onDetach);
    }
    this.serial = this.serial.then(async () => {
      if (this.session !== null) {
        const session = this.session;
        this.session = null;
        await this.cleanup(session, this.disposed);
      }
      if (!this.current(generation)) return;
      const info = await this.debugger_.sendCommand("Target.getTargetInfo") as {
        targetInfo?: { type?: string; targetId?: string };
      };
      if (!this.current(generation)) return;
      if (info.targetInfo?.type !== "page" || !info.targetInfo.targetId) {
        throw new Error("browser pane capture requires a page target");
      }
      const attached = await this.debugger_.sendCommand("Target.attachToTarget", {
        targetId: info.targetInfo.targetId, flatten: true,
      }) as { sessionId?: string };
      if (typeof attached.sessionId !== "string" || attached.sessionId === "") {
        throw new Error("browser pane capture attachment has no session");
      }
      const session = attached.sessionId;
      this.owned.add(session);
      if (!this.current(generation)) {
        await this.cleanup(session, true);
        return;
      }
      this.session = session;
      this.sessionGeneration = generation;
      await this.debugger_.sendCommand("Page.startScreencast", {
        format: "jpeg", quality: this.quality, everyNthFrame: 1,
      }, session);
    }).catch((error: unknown) => this.fail(generation, error)).finally(() => {
      if (generation === this.generation && !this.enabled) this.releaseListeners();
    });
  }

  private current(generation: number): boolean {
    return !this.disposed && this.enabled && generation === this.generation;
  }

  private async cleanup(session: string, bestEffort: boolean): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      await this.debugger_.sendCommand("Page.stopScreencast", {}, session);
    } catch (error) {
      failure = { error };
    }
    try {
      await this.debugger_.sendCommand("Target.detachFromTarget", { sessionId: session });
    } catch (error) {
      failure ??= { error };
    } finally {
      this.owned.delete(session);
    }
    if (!bestEffort && failure !== undefined) throw failure.error;
  }

  private fail(generation: number, error: unknown): void {
    if (!this.current(generation)) return;
    const failedGeneration = this.fence();
    const session = this.session;
    this.session = null;
    this.serial = this.serial.then(async () => {
      if (session !== null) await this.cleanup(session, true);
      if (failedGeneration === this.generation) this.releaseListeners();
    });
    this.options.onError(error instanceof Error ? error : new Error(String(error)));
  }

  private readonly onDetach = (_event: unknown, reason: string): void => {
    this.fail(this.generation, new Error(`browser pane debugger detached: ${reason}`));
  };

  private readonly onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string): void => {
    if (method !== "Page.screencastFrame" || sessionId === undefined || !this.owned.has(sessionId)) return;
    const params_ = params as { data?: unknown; sessionId?: unknown } | null;
    const frame: EncodedFrame = {
      data: typeof params_?.data === "string" ? params_.data : "",
      token: params_?.sessionId,
      session: sessionId,
      generation: this.sessionGeneration,
    };
    if (!this.current(frame.generation) || sessionId !== this.session || typeof params_?.data !== "string") {
      this.ack(frame);
      return;
    }
    const superseded = this.pending;
    this.pending = frame;
    if (superseded !== null) this.ack(superseded);
    this.publish();
  };

  private ack(frame: EncodedFrame): void {
    // Tokens can repeat; ownership belongs to this event, not to its token.
    try {
      void this.debugger_.sendCommand("Page.screencastFrameAck", { sessionId: frame.token }, frame.session)
        .catch((error: unknown) => {
          if (frame.session === this.session) this.fail(frame.generation, error);
        });
    } catch (error) {
      if (frame.session === this.session) this.fail(frame.generation, error);
    }
  }

  private publish(): void {
    const pending = this.pending;
    if (pending === null || !this.current(pending.generation)) return;
    const now = performance.now();
    const delay = this.lastPublished === null ? 0 : 1000 / this.options.fps - (now - this.lastPublished);
    if (delay > 0) {
      if (this.timer === undefined) this.timer = setTimeout(() => {
        this.timer = undefined;
        this.publish();
      }, Math.ceil(delay));
      return;
    }
    this.pending = null;
    try {
      const started = performance.now();
      const jpeg = Buffer.from(pending.data, "base64");
      const dimensions = jpegDimensions(jpeg);
      const processMs = performance.now() - started;
      if (dimensions === null) return;
      this.lastPublished = performance.now();
      this.options.onFrame({ jpeg, ...dimensions, processMs });
    } catch (error) {
      this.fail(pending.generation, error);
    } finally {
      this.ack(pending);
    }
  }
}
