import type { BrowserClockStampMime } from "@omp-ui/core/browser-pane";

/**
 * The browser clock stamp (see CONTEXT.md "Browser clock"): a dark rounded
 * badge with the date and time in an image's top-right corner. The renderer
 * uses it for the camera and pick hand-backs; main's clock-stamper page uses
 * the same code for agent screenshots, so every stamp looks identical.
 * Geometry is CSS px multiplied by the image's scale.
 */
const FONT_PX = 13;
const PAD_X = 10;
const PAD_Y = 6;
export const CLOCK_STAMP_MARGIN = 8;
const RADIUS = 6;
const LINE_HEIGHT = 1.3;
const FONT_STACK = 'system-ui, Cantarell, "Segoe UI", sans-serif';
const BADGE_FILL = "rgba(0, 0, 0, 0.78)";
const STRIP_FILL = "#000";
const INK = "#fff";

/** JPEG quality of stamped hand-backs; matches cropFrame's default 0.85. */
export const STAMPED_JPEG_QUALITY = 85;

export interface ClockStampLayout {
  canvasWidth: number;
  canvasHeight: number;
  /** Where the source image's top edge lands: 0 when the badge fits over it, else the strip height. */
  imageY: number;
  box: { x: number; y: number; width: number; height: number };
  textX: number;
  /** Vertical centre of the box (textBaseline "middle"). */
  textY: number;
  radius: number;
}

export function clockStampFont(scale: number): string {
  return `600 ${Math.round(FONT_PX * Math.max(1, scale))}px ${FONT_STACK}`;
}

/**
 * Badge placement. An image too small to hold the badge plus margins grows
 * a black strip on top (and widens to fit), so a tiny clip still carries the time.
 */
export function layoutClockStamp(
  imageWidth: number,
  imageHeight: number,
  textWidth: number,
  scale: number,
): ClockStampLayout {
  const s = Math.max(1, scale);
  const fontPx = Math.round(FONT_PX * s);
  const padX = Math.round(PAD_X * s);
  const padY = Math.round(PAD_Y * s);
  const margin = Math.round(CLOCK_STAMP_MARGIN * s);
  const width = Math.ceil(textWidth) + 2 * padX;
  const height = Math.round(fontPx * LINE_HEIGHT) + 2 * padY;
  const fits = imageWidth >= width + 2 * margin && imageHeight >= height + 2 * margin;
  const strip = fits ? 0 : height + 2 * margin;
  const canvasWidth = fits ? imageWidth : Math.max(imageWidth, width + 2 * margin);
  const box = { x: canvasWidth - margin - width, y: margin, width, height };
  return {
    canvasWidth,
    canvasHeight: imageHeight + strip,
    imageY: strip,
    box,
    textX: box.x + padX,
    textY: box.y + height / 2,
    radius: Math.round(RADIUS * s),
  };
}

/**
 * How big the badge is: a known image-pixels-per-CSS-pixel `scale` (the
 * pane's own frames), or the CSS width the image spans, from which the scale
 * is read off the decoded image (agent captures, whose density the agent's
 * own emulation decides).
 */
export type ClockStampSize = { scale: number } | { cssWidth: number };

/** Decodes, stamps, and re-encodes in the same format. Rejects on a decode, context, or encode failure. */
export async function stampImage(
  bytes: Uint8Array,
  mimeType: BrowserClockStampMime,
  quality: number | null,
  text: string,
  size: ClockStampSize,
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
  try {
    const scale = "scale" in size ? size.scale : size.cssWidth > 0 ? bitmap.width / size.cssWidth : 1;
    const font = clockStampFont(scale);
    const probe = new OffscreenCanvas(1, 1).getContext("2d");
    if (probe === null) throw new Error("no 2d context");
    probe.font = font;
    const layout = layoutClockStamp(bitmap.width, bitmap.height, probe.measureText(text).width, scale);
    const canvas = new OffscreenCanvas(layout.canvasWidth, layout.canvasHeight);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context");
    if (layout.imageY > 0) {
      ctx.fillStyle = STRIP_FILL;
      ctx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);
    }
    ctx.drawImage(bitmap, 0, layout.imageY);
    ctx.fillStyle = BADGE_FILL;
    ctx.beginPath();
    ctx.roundRect(layout.box.x, layout.box.y, layout.box.width, layout.box.height, layout.radius);
    ctx.fill();
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.fillStyle = INK;
    ctx.fillText(text, layout.textX, layout.textY);
    const blob = await canvas.convertToBlob(
      quality === null || mimeType === "image/png" ? { type: mimeType } : { type: mimeType, quality: quality / 100 },
    );
    if (blob.type !== mimeType) throw new Error(`the encoder produced ${blob.type}, not ${mimeType}`);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
