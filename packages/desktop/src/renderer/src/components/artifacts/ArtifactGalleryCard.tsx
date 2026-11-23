import { useEffect, useRef, useState } from "react";
import type { ArtifactListItem } from "@omp-ui/core/artifacts";
import { backend } from "../../backend";
import { ARTIFACT_DRAG_MIME } from "../../lib/artifact-drag";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useTheme } from "../../lib/themes";
import { Button, Chip } from "../ui";
import { getCachedThumbnail, setCachedThumbnail } from "./artifact-thumbnail-cache";

export interface ArtifactGalleryCardProps {
  row: ArtifactListItem;
  scheduled: boolean;
  thumbnailBump: number;
  onOpen: (artifactId: string) => void;
  onPin: (row: ArtifactListItem) => void;
  onQuickAction: (row: ArtifactListItem, mode: "reference" | "refresh") => void;
}

function expectedHashFor(row: ArtifactListItem, dark: boolean): string | null {
  const preferred = dark ? row.thumbnails.dark : row.thumbnails.light;
  const fallback = dark ? row.thumbnails.light : row.thumbnails.dark;
  return preferred?.hash ?? fallback?.hash ?? null;
}

export function ArtifactGalleryCard({
  row,
  scheduled,
  thumbnailBump,
  onOpen,
  onPin,
  onQuickAction,
}: ArtifactGalleryCardProps) {
  const theme = useTheme();
  const cardRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const expectedHash = expectedHashFor(row, theme.dark);
  const [thumbUrl, setThumbUrl] = useState<string | null>(() =>
    expectedHash ? getCachedThumbnail(expectedHash) : null,
  );
  const ensuredRef = useRef<string | null>(null);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const cached = expectedHash ? getCachedThumbnail(expectedHash) : null;
    if (cached !== null && thumbnailBump === 0) {
      setThumbUrl(cached);
      return;
    }
    if (expectedHash === null && thumbnailBump === 0) {
      setThumbUrl(null);
      return;
    }
    let canceled = false;
    void backend
      .artifactReadThumbnail({ artifactId: row.artifactId, dark: theme.dark })
      .then((result) => {
        if (canceled) return;
        if (!result) {
          setThumbUrl(null);
          return;
        }
        const url = `data:${result.mime};base64,${result.base64}`;
        setCachedThumbnail(result.hash, url);
        setThumbUrl(url);
      })
      .catch(() => {
        if (!canceled) setThumbUrl(cached);
      });
    return () => {
      canceled = true;
    };
  }, [visible, row.artifactId, expectedHash, theme.dark, thumbnailBump]);

  // Document-only cards whose active-polarity thumbnail is missing or stale request
  // lazy offscreen capture once visible on desktop.
  useEffect(() => {
    if (!visible || row.managed) return;
    const host = window.ompArtifactHost;
    if (!host) return;
    const activeSlot = theme.dark ? row.thumbnails.dark : row.thumbnails.light;
    if (activeSlot && !activeSlot.stale) return;
    const key = `${row.artifactId}:${row.currentCodeRevisionId}:${row.currentDataSnapshotId}:${theme.dark ? "d" : "l"}`;
    if (ensuredRef.current === key) return;
    ensuredRef.current = key;
    void host
      .ensureDocumentThumbnail(row.artifactId, { dark: theme.dark, tokens: theme.tokens })
      .then((saved) => {
        if (!saved) return;
        return backend.artifactReadThumbnail({ artifactId: row.artifactId, dark: theme.dark }).then((result) => {
          if (!result) return;
          const url = `data:${result.mime};base64,${result.base64}`;
          setCachedThumbnail(result.hash, url);
          setThumbUrl(url);
        });
      })
      .catch(() => {
        // Best-effort capture; allow retry on next mount.
        if (ensuredRef.current === key) ensuredRef.current = null;
      });
  }, [visible, row.artifactId, row.managed, row.currentCodeRevisionId, row.currentDataSnapshotId, row.thumbnails.dark, row.thumbnails.light, theme]);

  const statusChip =
    row.pendingCaptureCount > 0
      ? { label: "Capture to review", tone: "copper" as const }
      : row.pendingCandidateCount > 0
        ? { label: "Revision ready", tone: "iris" as const }
        : scheduled
          ? { label: "↻ Scheduled", tone: "signal" as const }
          : null;

  const canRefresh = row.managed && row.datasetCount > 0;
  const originLabel = row.originContext.kind === "chat" ? "Chat" : row.originContext.label;
  const pinned = row.pinnedAt !== null;

  return (
    <article
      ref={cardRef}
      draggable
      data-artifact-card={row.artifactId}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          ARTIFACT_DRAG_MIME,
          JSON.stringify({
            artifactId: row.artifactId,
            codeRevisionId: row.currentCodeRevisionId,
            dataSnapshotId: row.currentDataSnapshotId,
            instanceId: null,
          }),
        );
        event.dataTransfer.effectAllowed = "copy";
      }}
      className="group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-line-strong"
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden border-b border-line-soft bg-sunken">
        <button
          type="button"
          onClick={() => onOpen(row.artifactId)}
          aria-label={`Open ${row.title}`}
          className="block h-full w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper"
        >
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              className="h-full w-full object-cover object-top"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full flex-col justify-between p-3 text-ink-faint">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider">
                <span>{row.managed ? "Managed" : "Document"}</span>
                <span>·</span>
                <span>{`v${row.revisionNumber}`}</span>
              </div>
              <p className="line-clamp-2 text-sm font-medium text-ink-mid">{row.title}</p>
              <span className="truncate text-xs text-ink-faint">{originLabel}</span>
            </div>
          )}
        </button>

        {statusChip && (
          <div className="pointer-events-none absolute left-2 top-2">
            <Chip tone={statusChip.tone}>{statusChip.label}</Chip>
          </div>
        )}

        <button
          type="button"
          aria-label={pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
          aria-pressed={pinned}
          onClick={(event) => {
            event.stopPropagation();
            onPin(row);
          }}
          className={cn(
            "absolute right-2 top-2 flex size-6 items-center justify-center rounded-md border border-line bg-overlay/85 text-xs backdrop-glass transition-opacity focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper",
            pinned ? "text-copper opacity-100" : "text-ink-dim opacity-0 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {pinned ? "★" : "☆"}
        </button>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-gradient-to-t from-void/85 via-void/50 to-transparent px-2 pb-2 pt-5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            size="xs"
            variant="ghost"
            className="pointer-events-auto bg-overlay/90 backdrop-glass"
            onClick={() => onQuickAction(row, "reference")}
          >
            @ Reference
          </Button>
          {canRefresh && (
            <Button
              size="xs"
              variant="ghost"
              className="pointer-events-auto bg-overlay/90 backdrop-glass"
              onClick={() => onQuickAction(row, "refresh")}
            >
              ↻ Refresh
            </Button>
          )}
          <Button
            size="xs"
            variant="solid"
            className="pointer-events-auto"
            onClick={() => onOpen(row.artifactId)}
          >
            Open
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between gap-1.5 p-2.5">
        <button
          type="button"
          onClick={() => onOpen(row.artifactId)}
          className="min-w-0 truncate text-left text-sm font-medium text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper"
          title={row.title}
        >
          {row.title}
        </button>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-dim">
          <Chip tone={row.managed ? "iris" : "neutral"}>{row.managed ? "Managed" : "Doc"}</Chip>
          <span className="min-w-0 truncate" title={row.originContext.kind === "project" ? row.originContext.path : "Chat"}>
            {originLabel}
          </span>
          <span className="text-ink-faint">·</span>
          <span className="font-mono text-ink-faint">{`v${row.revisionNumber}`}</span>
          <span className="ml-auto shrink-0 text-ink-faint" title={new Date(row.updatedAt).toLocaleString()}>
            {relativeTime(row.updatedAt)}
          </span>
        </div>
      </div>
    </article>
  );
}
