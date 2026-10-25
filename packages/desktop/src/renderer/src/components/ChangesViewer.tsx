import { useEffect, useId, useMemo, useState } from "react";
import { useT } from "../lib/i18n";
import { diffCounts, type DiffRow } from "../lib/omp-diff";
import { useStore } from "../store";
import { DiffViewer } from "./DiffViewer";
import { Button, Modal } from "./ui";

/** The event every exchange receipt dispatches; mirrors VIEWER_EVENT in ImageViewer.tsx. */
const CHANGES_EVENT = "omp-ui:changes-viewer";

declare global {
  interface WindowEventMap {
    "omp-ui:changes-viewer": CustomEvent<ChangesOpenDetail | undefined>;
  }
}

/** One edit card: a tool-call's diff, keyed by the transcript item that owns it. */
export interface ChangesViewerCard {
  key: string;
  path?: string;
  op?: string;
  rows: DiffRow[];
}

interface ChangesOpenDetail {
  cards: ChangesViewerCard[];
  /** Present when the working-tree footer button can jump the rail to Diffs. */
  tabId?: string;
}

/** Opens the viewer from anywhere; a detail with no cards is ignored. */
export function openChangesViewer(detail: ChangesOpenDetail): void {
  if (detail.cards.length === 0) return;
  window.dispatchEvent(new CustomEvent(CHANGES_EVENT, { detail }));
}

/** Listens once and renders the viewer. Mount exactly one, in App. */
export function ChangesViewerHost() {
  const [detail, setDetail] = useState<ChangesOpenDetail | null>(null);
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<ChangesOpenDetail | undefined>).detail;
      if (d !== undefined && d.cards.length > 0) setDetail(d);
    };
    window.addEventListener(CHANGES_EVENT, onOpen);
    return () => window.removeEventListener(CHANGES_EVENT, onOpen);
  }, []);
  if (detail === null) return null;
  return <ChangesViewer detail={detail} onClose={() => setDetail(null)} />;
}

/**
 * The exchange-changes overlay: every diff an exchange touched, newest last.
 * Escape and a backdrop click close it (useOverlay via Modal); while it is open
 * #root is inert, so a re-open always remounts and reseeds the open set.
 */
function ChangesViewer({
  detail,
  onClose,
}: {
  detail: ChangesOpenDetail;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const { cards, tabId } = detail;
  // One card opens by default (a lone diff should not hide); many stay closed
  // so the summary is scannable. Controlled either way so expand/collapse-all
  // works — same openPaths idiom as DiffsPane in InspectorRail.tsx.
  const single = cards.length === 1 ? cards[0]?.key : undefined;
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(
    () => new Set(single !== undefined ? [single] : []),
  );

  const files = useMemo(() => new Set(cards.map((c) => c.path)).size, [cards]);
  const totals = useMemo(
    () =>
      cards.reduce(
        (acc, c) => {
          const n = diffCounts(c.rows);
          return { added: acc.added + n.added, removed: acc.removed + n.removed };
        },
        { added: 0, removed: 0 },
      ),
    [cards],
  );

  // Two edits to one file read as `path` and `path#2`, `path#3`… — the plain
  // path stays on the first card, so each row is still identifiable at a glance.
  const shownPaths = useMemo(() => {
    const seen = new Map<string, number>();
    return cards.map((c) => {
      if (c.path === undefined) return undefined;
      const n = (seen.get(c.path) ?? 0) + 1;
      seen.set(c.path, n);
      return n === 1 ? c.path : `${c.path}#${n}`;
    });
  }, [cards]);

  const expandable = cards.filter((c) => c.rows.length > 0);
  const allOpen =
    expandable.length > 0 && expandable.every((c) => openKeys.has(c.key));

  return (
    <Modal
      onClose={onClose}
      width="w-[64rem]"
      labelledBy={titleId}
      className="max-h-[80vh] flex flex-col"
    >
      <div className="flex items-center justify-between gap-3 pr-10">
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-ink">
          {t("changes.header", { files, edits: cards.length })}
        </h2>
        <span className="flex shrink-0 items-center gap-2 text-[11px]">
          {/* Add/delete colors match the DiffViewer headers below (ADR-0004). */}
          <span className="tabular-nums">
            <span className="text-signal">+{totals.added}</span>{" "}
            <span className="text-rose">−{totals.removed}</span>
          </span>
          {expandable.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                setOpenKeys(
                  allOpen
                    ? new Set()
                    : new Set(expandable.map((c) => c.key)),
                )
              }
            >
              {allOpen ? t("changes.collapseAll") : t("changes.expandAll")}
            </Button>
          )}
        </span>
      </div>
      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {cards.map((card, i) => (
          <DiffViewer
            key={card.key}
            rows={card.rows}
            path={shownPaths[i]}
            op={card.op}
            open={openKeys.has(card.key)}
            defaultOpen={single !== undefined}
            onOpenChange={(v) =>
              setOpenKeys((prev) => {
                const next = new Set(prev);
                if (v) next.add(card.key);
                else next.delete(card.key);
                return next;
              })
            }
          />
        ))}
      </div>
      {/* The exchange diff came from the working tree; offer the live pane. */}
      {tabId !== undefined && (
        <div className="mt-3 flex justify-end">
          <Button
            size="xs"
            onClick={() => {
              useStore.getState().focusRailPane(tabId, "diffs");
              onClose();
            }}
          >
            {t("changes.workingTree")}
          </Button>
        </div>
      )}
    </Modal>
  );
}
