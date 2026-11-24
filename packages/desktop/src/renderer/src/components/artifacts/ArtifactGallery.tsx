import { useEffect, useMemo, useRef, useState } from "react";
import {
  ARTIFACT_LIMITS,
  type ArtifactListFilter,
  type ArtifactListItem,
  type ArtifactListResult,
  type ArtifactListSort,
} from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { ARTIFACT_DRAG_MIME } from "../../lib/artifact-drag";
import { cn } from "../../lib/cn";
import { formatBytes, relativeTime } from "../../lib/format";
import { useStore } from "../../store";
import { Button, Chip, Empty, IconButton, IconClose } from "../ui";
import { ArtifactGalleryCard } from "./ArtifactGalleryCard";

const LAYOUT_STORAGE_KEY = "omp-ui:artifacts-layout";
const PAGE_SIZE = 40;

type GalleryLayout = "grid" | "list";

function readInitialLayout(): GalleryLayout {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export interface ArtifactGalleryProps {
  onOpenArtifact: (artifactId: string, opts?: { panel?: "preview" | "data" | "history" }) => void;
  onQuickAction: (row: ArtifactListItem, mode: "reference" | "refresh") => void;
  onClose: () => void;
}

export function ArtifactGallery({ onOpenArtifact, onQuickAction, onClose }: ArtifactGalleryProps) {
  const revision = useStore((s) => s.artifactLibraryRevision);
  const lastChange = useStore((s) => s.artifactLastChange);
  const routinesState = useStore((s) => s.routinesState);

  const [layout, setLayout] = useState<GalleryLayout>(readInitialLayout);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<ArtifactListFilter>("all");
  const [origin, setOrigin] = useState<string>("");
  const [sort, setSort] = useState<ArtifactListSort>("recent");

  const [rows, setRows] = useState<ArtifactListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [meta, setMeta] = useState<Pick<ArtifactListResult, "libraryBytesUsed" | "totalCount" | "pendingReviewCount" | "pendingReviewPreview" | "origins"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbBumps, setThumbBumps] = useState<Record<string, number>>({});

  const requestGen = useRef(0);
  const rowsLengthRef = useRef(0);
  rowsLengthRef.current = rows.length;
  const lastRevisionRef = useRef(revision);

  const scheduledArtifactIds = useMemo(() => {
    const ids = new Set<string>();
    for (const routine of routinesState?.routines ?? []) {
      if (routine.artifact?.artifactId) ids.add(routine.artifact.artifactId);
    }
    return ids;
  }, [routinesState]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchInput), 150);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const setPersistedLayout = (next: GalleryLayout): void => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // ignore storage failures
    }
  };

  const fetchPages = async (targetCount: number, gen: number): Promise<void> => {
    setLoading(true);
    try {
      const collected: ArtifactListItem[] = [];
      let nextCursor: string | undefined;
      let latestMeta: ArtifactListResult | null = null;
      const maxPages = Math.max(1, Math.ceil(targetCount / PAGE_SIZE));

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const remaining = targetCount - collected.length;
        const limit = Math.min(50, maxPages === 1 ? PAGE_SIZE : Math.max(1, remaining));
        const page = await backend.artifactList({
          ...(debouncedQuery ? { query: debouncedQuery } : {}),
          ...(filter !== "all" ? { filter } : {}),
          ...(origin ? { origin } : {}),
          sort,
          limit,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        if (gen !== requestGen.current) return;
        latestMeta = page;
        for (const item of page.artifacts) {
          if (!collected.some((existing) => existing.artifactId === item.artifactId)) {
            collected.push(item);
          }
        }
        if (page.nextCursor === null || page.artifacts.length === 0 || collected.length >= targetCount) {
          break;
        }
        nextCursor = page.nextCursor;
      }
      if (gen !== requestGen.current || !latestMeta) return;
      setRows(collected);
      setCursor(latestMeta.nextCursor);
      setMeta({
        libraryBytesUsed: latestMeta.libraryBytesUsed,
        totalCount: latestMeta.totalCount,
        pendingReviewCount: latestMeta.pendingReviewCount,
        pendingReviewPreview: latestMeta.pendingReviewPreview,
        origins: latestMeta.origins,
      });
      setError(null);
    } catch (reason) {
      if (gen === requestGen.current) setError(displayMessage(reason));
    } finally {
      if (gen === requestGen.current) setLoading(false);
    }
  };

  // Query/filter/origin/sort changes always start fresh at page 1.
  useEffect(() => {
    const gen = ++requestGen.current;
    void fetchPages(PAGE_SIZE, gen);
  }, [debouncedQuery, filter, origin, sort]);

  // Library mutations: thumbnail-only events patch affected cards in place without
  // collapsing Load more pages; other changes re-fetch the loaded row count.
  useEffect(() => {
    if (revision === lastRevisionRef.current) return;
    lastRevisionRef.current = revision;
    if (lastChange?.kind === "thumbnail" && lastChange.artifactIds.length > 0) {
      const affected = new Set(lastChange.artifactIds);
      setThumbBumps((old) => {
        const next = { ...old };
        for (const id of affected) next[id] = (next[id] ?? 0) + 1;
        return next;
      });
      void Promise.all(
        lastChange.artifactIds.map((artifactId) =>
          backend.artifactDescribe({ artifactId }).then(
            (desc) => ({ artifactId, thumbnails: desc.thumbnails }),
            () => null,
          ),
        ),
      ).then((updates) => {
        const map = new Map(
          updates
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .map((item) => [item.artifactId, item.thumbnails]),
        );
        if (map.size === 0) return;
        setRows((old) =>
          old.map((row) => {
            const nextThumbs = map.get(row.artifactId);
            return nextThumbs ? { ...row, thumbnails: nextThumbs } : row;
          }),
        );
      });
      return;
    }
    const gen = ++requestGen.current;
    void fetchPages(Math.max(PAGE_SIZE, rowsLengthRef.current), gen);
  }, [revision, lastChange]);

  const loadMore = async (): Promise<void> => {
    if (!cursor || loading) return;
    const gen = requestGen.current;
    setLoading(true);
    try {
      const page = await backend.artifactList({
        ...(debouncedQuery ? { query: debouncedQuery } : {}),
        ...(filter !== "all" ? { filter } : {}),
        ...(origin ? { origin } : {}),
        sort,
        limit: PAGE_SIZE,
        cursor,
      });
      if (gen !== requestGen.current) return;
      setRows((old) => [
        ...old,
        ...page.artifacts.filter((item) => !old.some((existing) => existing.artifactId === item.artifactId)),
      ]);
      setCursor(page.nextCursor);
      setMeta({
        libraryBytesUsed: page.libraryBytesUsed,
        totalCount: page.totalCount,
        pendingReviewCount: page.pendingReviewCount,
        pendingReviewPreview: page.pendingReviewPreview,
        origins: page.origins,
      });
    } catch (reason) {
      if (gen === requestGen.current) setError(displayMessage(reason));
    } finally {
      if (gen === requestGen.current) setLoading(false);
    }
  };

  const handlePin = async (row: ArtifactListItem): Promise<void> => {
    setError(null);
    try {
      await backend.artifactPin({
        artifactId: row.artifactId,
        expectedGeneration: row.generation,
        pinned: row.pinnedAt === null,
      });
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    }
  };

  const pinnedRows = useMemo(() => rows.filter((row) => row.pinnedAt !== null), [rows]);
  const unpinnedRows = useMemo(() => rows.filter((row) => row.pinnedAt === null), [rows]);
  const quotaUsed = meta?.libraryBytesUsed ?? null;
  const quotaWarning = quotaUsed !== null && quotaUsed > ARTIFACT_LIMITS.libraryBytes * 0.8;
  const unfilteredAll = filter === "all" && !debouncedQuery && !origin;
  const showAttentionStrip = unfilteredAll && (meta?.pendingReviewCount ?? 0) > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col @container">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line chrome-void px-4 py-2.5">
        <Button size="xs" variant="ghost" onClick={onClose} className="-ml-1">
          ← Sessions
        </Button>
        <h1 className="text-base font-semibold tracking-tight text-ink">Artifacts</h1>
        {meta !== null && <Chip tone="neutral">{`${meta.totalCount} kept`}</Chip>}
        <Chip tone="neutral">Host-local</Chip>
        <span className="flex-1" />
        {quotaUsed !== null && (
          <span
            className={cn("text-xs", quotaWarning ? "text-rose" : "text-ink-dim")}
            title="Logical library footprint across all kept artifacts and retained versions."
          >
            {`Library ${formatBytes(quotaUsed)} of ${formatBytes(ARTIFACT_LIMITS.libraryBytes)}`}
            {quotaWarning && <span className="ml-1.5">Free space with History → Prune old versions.</span>}
          </span>
        )}
        <div className="inline-flex rounded-md border border-line bg-raised p-0.5 text-xs" role="group" aria-label="Gallery layout">
          <button
            type="button"
            aria-pressed={layout === "grid"}
            onClick={() => setPersistedLayout("grid")}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              layout === "grid" ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink",
            )}
          >
            Grid
          </button>
          <button
            type="button"
            aria-pressed={layout === "list"}
            onClick={() => setPersistedLayout("list")}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              layout === "list" ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink",
            )}
          >
            List
          </button>
        </div>
        <IconButton label="close dialog" onClick={onClose}>
          <IconClose />
        </IconButton>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-sunken/40 px-4 py-2">
        <label className="min-w-44 flex-1 @[48rem]:max-w-xs">
          <span className="sr-only">Search artifacts</span>
          <input
            type="search"
            placeholder="Search artifacts or projects…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="w-full min-w-0 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-ink outline-none focus-visible:border-copper"
          />
        </label>

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Artifact filter">
          {(
            [
              { id: "all", label: "All" },
              {
                id: "review",
                label:
                  (meta?.pendingReviewCount ?? 0) > 0
                    ? `Needs review (${meta!.pendingReviewCount})`
                    : "Needs review",
              },
              { id: "managed", label: "Managed" },
              { id: "document", label: "Documents" },
            ] as const
          ).map((pill) => (
            <Button
              key={pill.id}
              size="xs"
              selected={filter === pill.id}
              onClick={() => setFilter(pill.id)}
            >
              {pill.label}
            </Button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-ink-dim">
          <span className="sr-only">Origin project</span>
          <select
            aria-label="Origin project"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            className="max-w-44 rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink"
          >
            <option value="">All origins</option>
            {(meta?.origins ?? []).map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-ink-dim">
          <span className="sr-only">Sort artifacts</span>
          <select
            aria-label="Sort artifacts"
            value={sort}
            onChange={(event) => setSort(event.target.value as ArtifactListSort)}
            className="rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink"
          >
            <option value="recent">Recent</option>
            <option value="name">Name</option>
            <option value="revisions">Revisions</option>
          </select>
        </label>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]" aria-label="Kept artifacts">
        {error && (
          <p role="alert" className="mb-4 break-words rounded-md border border-rose/30 bg-rose/5 p-3 text-sm text-rose">
            {error}
          </p>
        )}

        {showAttentionStrip && meta && (
          <section
            aria-label="Needs review"
            data-artifacts-attention-strip
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-copper/40 bg-copper-wash/30 px-3 py-2 text-xs"
          >
            <span className="font-semibold text-copper">
              {`${meta.pendingReviewCount} item${meta.pendingReviewCount === 1 ? "" : "s"} ready to review`}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {meta.pendingReviewPreview.map((item) => (
                <Button
                  key={item.artifactId}
                  size="xs"
                  variant="ghost"
                  className="max-w-xs truncate bg-surface/80"
                  onClick={() =>
                    onOpenArtifact(item.artifactId, {
                      panel: item.pendingCaptureCount > 0 ? "data" : "preview",
                    })
                  }
                >
                  {`${item.title} (${item.pendingCaptureCount > 0 ? "capture" : "revision"}) →`}
                </Button>
              ))}
            </div>
            {meta.pendingReviewCount > meta.pendingReviewPreview.length && (
              <Button size="xs" variant="ghost" onClick={() => setFilter("review")}>
                View all
              </Button>
            )}
          </section>
        )}

        {!loading && rows.length === 0 ? (
          <div className="mx-auto max-w-md py-12">
            <Empty
              title={
                debouncedQuery || filter !== "all" || origin
                  ? "No artifacts match these filters"
                  : "Your kept work, independent of the session"
              }
              hint={
                debouncedQuery || filter !== "all" || origin
                  ? "Clear search or switch filters to see all kept artifacts."
                  : "Keep an artifact from a native session to see it here. There is no builder here; artifacts begin in your sessions."
              }
            />
          </div>
        ) : layout === "grid" ? (
          <div className="space-y-6">
            {pinnedRows.length > 0 && (
              <section aria-label="Pinned artifacts" data-artifacts-pinned-section className="space-y-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Pinned</h2>
                <div className="grid grid-cols-1 gap-4 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3 @[78rem]:grid-cols-4">
                  {pinnedRows.map((row) => (
                    <ArtifactGalleryCard
                      key={row.artifactId}
                      row={row}
                      scheduled={scheduledArtifactIds.has(row.artifactId)}
                      thumbnailBump={thumbBumps[row.artifactId] ?? 0}
                      onOpen={(id) => onOpenArtifact(id)}
                      onPin={(item) => void handlePin(item)}
                      onQuickAction={onQuickAction}
                    />
                  ))}
                </div>
              </section>
            )}
            {unpinnedRows.length > 0 && (
              <section aria-label="All artifacts" className="space-y-2.5">
                {pinnedRows.length > 0 && (
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">All artifacts</h2>
                )}
                <div className="grid grid-cols-1 gap-4 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3 @[78rem]:grid-cols-4">
                  {unpinnedRows.map((row) => (
                    <ArtifactGalleryCard
                      key={row.artifactId}
                      row={row}
                      scheduled={scheduledArtifactIds.has(row.artifactId)}
                      thumbnailBump={thumbBumps[row.artifactId] ?? 0}
                      onOpen={(id) => onOpenArtifact(id)}
                      onPin={(item) => void handlePin(item)}
                      onQuickAction={onQuickAction}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-line bg-sunken/50 text-ink-faint">
                  <th className="w-8 px-2 py-2 font-medium" aria-label="Pin" />
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Origin</th>
                  <th className="px-3 py-2 font-medium">Rev</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {rows.map((row) => {
                  const pinned = row.pinnedAt !== null;
                  const canRefresh = row.managed && row.datasetCount > 0;
                  const originLabel = row.originContext.kind === "chat" ? "Chat" : row.originContext.label;
                  return (
                    <tr
                      key={row.artifactId}
                      draggable
                      data-artifact-row={row.artifactId}
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
                      className="hover:bg-hover/50"
                    >
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          aria-label={pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
                          aria-pressed={pinned}
                          onClick={() => void handlePin(row)}
                          className={cn("text-sm", pinned ? "text-copper" : "text-ink-faint hover:text-ink")}
                        >
                          {pinned ? "★" : "☆"}
                        </button>
                      </td>
                      <td className="max-w-xs px-3 py-2 font-medium text-ink">
                        <button
                          type="button"
                          onClick={() => onOpenArtifact(row.artifactId)}
                          className="block max-w-full truncate text-left hover:underline"
                        >
                          {row.title}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <Chip tone={row.managed ? "iris" : "neutral"}>{row.managed ? "Managed" : "Doc"}</Chip>
                      </td>
                      <td className="max-w-[12rem] truncate px-3 py-2 text-ink-mid" title={row.originContext.kind === "project" ? row.originContext.path : "Chat"}>
                        {originLabel}
                      </td>
                      <td className="px-3 py-2 font-mono text-ink-dim">{`v${row.revisionNumber}`}</td>
                      <td className="px-3 py-2">
                        {row.pendingCaptureCount > 0 ? (
                          <Chip tone="copper">Capture to review</Chip>
                        ) : row.pendingCandidateCount > 0 ? (
                          <Chip tone="iris">Revision ready</Chip>
                        ) : scheduledArtifactIds.has(row.artifactId) ? (
                          <Chip tone="signal">↻ Scheduled</Chip>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-ink-dim" title={new Date(row.updatedAt).toLocaleString()}>
                        {relativeTime(row.updatedAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button size="xs" variant="ghost" onClick={() => onQuickAction(row, "reference")}>@ Reference</Button>
                          {canRefresh && (
                            <Button size="xs" variant="ghost" onClick={() => onQuickAction(row, "refresh")}>↻ Refresh</Button>
                          )}
                          <Button size="xs" onClick={() => onOpenArtifact(row.artifactId)}>Open</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {cursor && (
          <div className="mt-4 flex justify-center">
            <Button disabled={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
