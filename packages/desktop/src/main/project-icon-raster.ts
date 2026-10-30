import { nativeImage } from "electron";
import { PROJECT_ICON_PX, type RasterNormalizer } from "@omp-ui/core";

/**
 * The project-icon raster step (issue #1000), the one part of icon handling
 * core cannot do (ADR-0002): decode PNG/JPEG with Electron's `nativeImage`,
 * shrink the longest edge to `PROJECT_ICON_PX` (never upscale), re-encode as
 * PNG. nativeImage decodes neither ICO, SVG, GIF nor WebP (probed on
 * Electron 43); core passes those through under its size cap instead.
 */
export const normalizeProjectIconRaster: RasterNormalizer = (bytes) => {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return null;
  const scaled =
    Math.max(width, height) <= PROJECT_ICON_PX
      ? image
      : image.resize(width >= height ? { width: PROJECT_ICON_PX, quality: "best" } : { height: PROJECT_ICON_PX, quality: "best" });
  return new Uint8Array(scaled.toPNG());
};
