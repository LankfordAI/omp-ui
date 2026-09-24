import { useEffect, useId, useState } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { Chevron, IconClose, IconButton, Modal } from "./ui";

/** The event every thumbnail dispatches; mirrors PALETTE_EVENT in CommandPalette.tsx. */
const VIEWER_EVENT = "omp-ui:image-viewer";

declare global {
  interface WindowEventMap {
    "omp-ui:image-viewer": CustomEvent<ViewerOpenDetail | undefined>;
  }
}

/** One displayable image. `src` is the data: URI the thumbnail already renders. */
export interface ViewerImage {
  src: string;
  mimeType: string;
  label: string;
}

interface ViewerOpenDetail {
  images: ViewerImage[];
  index: number;
}

/** Opens the viewer from anywhere; a detail with no images is ignored. */
export function openImageViewer(images: ViewerImage[], index: number): void {
  if (images.length === 0) return;
  window.dispatchEvent(
    new CustomEvent(VIEWER_EVENT, { detail: { images, index } }),
  );
}

/** Listens once and renders the viewer. Mount exactly one, in App. */
export function ImageViewerHost() {
  const [open, setOpen] = useState<ViewerOpenDetail | null>(null);
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<ViewerOpenDetail | undefined>).detail;
      if (d !== undefined && d.images.length > 0) setOpen(d);
    };
    window.addEventListener(VIEWER_EVENT, onOpen);
    return () => window.removeEventListener(VIEWER_EVENT, onOpen);
  }, []);
  if (open === null) return null;
  return (
    <ImageViewer
      images={open.images}
      start={open.index}
      onClose={() => setOpen(null)}
    />
  );
}

/**
 * The large-image viewer. Escape and a backdrop click close it (useOverlay via
 * Modal); ArrowLeft/ArrowRight step a group; the canvas scrolls at actual size.
 * `start` is read once: nothing else can open the viewer while this is mounted,
 * because useOverlay makes #root inert, so a re-open always remounts.
 */
export function ImageViewer({
  images,
  start,
  onClose,
}: {
  images: ViewerImage[];
  start: number;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const [index, setIndex] = useState(
    Math.min(Math.max(0, start), images.length - 1),
  );
  const [actual, setActual] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const image = images[index]!;
  const many = images.length > 1;

  const step = (delta: number): void => {
    setIndex((i) => Math.min(images.length - 1, Math.max(0, i + delta)));
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      width="w-[min(1400px,96vw)]"
      mobile="fullscreen"
      className="flex max-h-[min(92dvh,var(--app-viewport-height,92dvh))] flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <h2 id={titleId} className="font-display text-xs font-semibold text-ink">
          {t("image.viewer.heading", { n: index + 1, count: images.length })}
        </h2>
        <span className="min-w-0 truncate font-mono text-[10px] text-ink-faint">
          {failed
            ? t("image.viewer.failed")
            : size === null
              ? image.mimeType
              : `${image.mimeType} · ${t("image.viewer.dimensions", size)}`}
        </span>
        <span className="min-w-0 flex-1" />
        {many && (
          <>
            <IconButton
              label={t("image.viewer.previous")}
              disabled={index === 0}
              onClick={() => step(-1)}
            >
              <Chevron open={false} className="rotate-180" />
            </IconButton>
            <IconButton
              label={t("image.viewer.next")}
              disabled={index === images.length - 1}
              onClick={() => step(1)}
            >
              <Chevron open={false} />
            </IconButton>
          </>
        )}
        <IconButton
          label={actual ? t("image.viewer.fit") : t("image.viewer.actual")}
          onClick={() => setActual((v) => !v)}
        >
          <span className="font-mono text-[10px]">{actual ? "1:1" : "fit"}</span>
        </IconButton>
        {/* Modal's own close button appears only under the compact shell's
            899px rule, so this one stands down there or the two would overlap. */}
        <IconButton
          label={t("common.overlay.close")}
          onClick={onClose}
          className="max-[899px]:hidden"
        >
          <IconClose />
        </IconButton>
      </header>
      <div
        tabIndex={-1}
        data-modal-initial-focus
        className="min-h-0 flex-1 overflow-auto bg-sunken p-3 outline-none"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" && many) step(-1);
          else if (e.key === "ArrowRight" && many) step(1);
          else return;
          e.preventDefault();
        }}
      >
        {/* min-h/min-w + centering: the image sits centred when it fits and the
            wrapper grows so overflow scrolling reaches every edge — plain
            flex-centering on the scroller would clip the top of a tall image. */}
        <div
          className={
            actual
              ? "w-max min-h-full min-w-full"
              : "flex min-h-full min-w-full items-center justify-center"
          }
        >
          <img
            src={image.src}
            alt={image.label}
            onLoad={(e) =>
              setSize({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
            onClick={() => setActual((v) => !v)}
            className={cn(
              "rounded border border-line-strong",
              actual
                ? "block cursor-zoom-out"
                : "block max-h-full max-w-full cursor-zoom-in object-contain",
            )}
          />
        </div>
      </div>
    </Modal>
  );
}
