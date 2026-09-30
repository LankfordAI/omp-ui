import {
  parseTreeSnapshot,
  TREE_STATUS_KEY,
  type TreeSnapshot,
} from "@omp-ui/core/session-tree";
import { useMemo, useState, type JSX } from "react";
import { useT, type MessageKey } from "../lib/i18n";
import { useStore } from "../store";
import { Chip, ICON_STROKE, IconSessionTree, Label, Modal } from "./ui";
import { IconPencil, IconRewind } from "./ui";

/**
 * The session tree navigator (issue #680, Phase 2): every entry the lineage
 * file holds, indented by parent, with the current branch marked and the
 * leaf badged. User-prompt rows carry the transcript's own rewind
 * affordances — a jump between branches at a prompt is omp's `branch` RPC;
 * any other row gets "navigate here", staged through the navigate
 * lifecycle confirmation and executed by the generated tree bridge. The
 * bridge's published snapshot (`extensionStatus[TREE_STATUS_KEY]`) is the
 * only source; the viewer never reads the transcript store itself.
 */

/** The branch glyph — a prompt row you can branch from, and "navigate here". Local because the HUD owns IconBranch. */
function IconTreeBranch() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" {...ICON_STROKE}>
      <circle cx="4" cy="3.8" r="1.7" />
      <circle cx="4" cy="12.2" r="1.7" />
      <circle cx="11.8" cy="4.6" r="1.7" />
      <path d="M4 5.5v5.1M10.1 4.6H8.4A4.4 4.4 0 004 9v1.4" />
    </svg>
  );
}

function reasonKey(reason: string | undefined): MessageKey {
  switch (reason) {
    case "read-failed":
      return "session.tree.reasonReadFailed";
    case "payload-too-large":
      return "session.tree.reasonPayloadTooLarge";
    default:
      return "session.tree.reasonMissingApi";
  }
}

interface Row {
  id: string;
  depth: number;
  type: string;
  role?: string;
  text: string;
  timestamp: string;
}

/** Depth-first rows ordered by parent chain; orphans still get a row. */
function rowsOf(snapshot: TreeSnapshot): Row[] {
  const childrenOf = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node.id);
    childrenOf.set(node.parentId, siblings);
  }
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const rows: Row[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (node !== undefined)
      rows.push({
        id: node.id,
        depth,
        type: node.type,
        role: node.role,
        text: node.text,
        timestamp: node.timestamp,
      });
    for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1);
  };
  for (const node of snapshot.nodes) if (node.parentId === null) walk(node.id, 0);
  // An entry whose parent never published (a truncated payload) still
  // shows, at depth 0, rather than vanishing from its own tree.
  for (const node of snapshot.nodes) walk(node.id, 0);
  return rows;
}

export function SessionTreeViewer(): JSX.Element | null {
  const t = useT();
  const viewer = useStore((s) => s.sessionTreeView);
  const closeSessionTreeView = useStore((s) => s.closeSessionTreeView);
  const published = useStore((s) =>
    viewer === null ? undefined : s.rpc[viewer.tabId]?.extensionStatus[TREE_STATUS_KEY],
  );
  const busy = useStore(
    (s) =>
      viewer !== null &&
      (s.rpc[viewer.tabId]?.status === "running" || s.rpc[viewer.tabId]?.busy === true),
  );
  const stageRewindEntry = useStore((s) => s.stageRewindEntry);
  const stageNavigate = useStore((s) => s.stageNavigate);
  const [summarize, setSummarize] = useState(false);

  const snapshot = useMemo(
    () => (published === undefined ? null : parseTreeSnapshot(published)),
    [published],
  );
  const rows = useMemo(
    () => (snapshot === null || !snapshot.available ? [] : rowsOf(snapshot)),
    [snapshot],
  );
  if (viewer === null) return null;
  const tabId = viewer.tabId;
  const activePath = new Set(
    snapshot !== null && snapshot.available ? snapshot.activePath : [],
  );
  const leafId = snapshot?.available === true ? snapshot.leafId : null;
  const disabled = busy || snapshot === null || !snapshot.available;
  const busyTitle = busy ? t("session.tree.busy") : undefined;

  return (
    <Modal
      onClose={closeSessionTreeView}
      width="w-[40rem]"
      labelledBy="session-tree-viewer-title"
      className="max-h-[80vh] flex flex-col"
    >
      <div className="flex items-baseline justify-between gap-3 pr-10">
        <div className="flex items-baseline gap-2">
          <IconSessionTree className="shrink-0" />
          <h2 id="session-tree-viewer-title" className="text-sm font-semibold text-ink">
            {t("session.tree.title")}
          </h2>
        </div>
        <Label>{t("session.tree.kicker")}</Label>
      </div>
      {snapshot === null ? (
        <p className="py-6 text-center text-xs text-ink-dim">{t("session.tree.empty")}</p>
      ) : !snapshot.available ? (
        <p className="py-6 text-center text-xs text-copper">
          {t("session.tree.unavailable", { reason: t(reasonKey(snapshot.reason)) })}
        </p>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <ul className="space-y-0.5">
            {rows.map((row) => {
              const isPrompt = row.type === "message" && row.role === "user";
              const active = activePath.has(row.id);
              return (
                <li
                  key={row.id}
                  className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover"
                  style={{ paddingLeft: `${0.5 + row.depth * 0.875}rem` }}
                  data-entry-id={row.id}
                >
                  {isPrompt ? (
                    <IconTreeBranch />
                  ) : (
                    <span className="size-3.5 shrink-0 text-center text-ink-faint">·</span>
                  )}
                  <span
                    className={
                      active
                        ? "min-w-0 flex-1 truncate text-ink"
                        : "min-w-0 flex-1 truncate text-ink-faint"
                    }
                    title={row.text === "" ? row.type : row.text}
                  >
                    {row.text === "" ? <em>{row.type}</em> : row.text}
                  </span>
                  {row.id === leafId && <Chip tone="signal">{t("session.tree.current")}</Chip>}
                  {active && row.id !== leafId && (
                    <span className="shrink-0 text-[10px] text-ink-mid">
                      {t("session.tree.active")}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                    {isPrompt ? (
                      <>
                        <button
                          type="button"
                          className="grid size-6 place-items-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:text-ink-faint"
                          aria-label={t("transcript.rewind.here")}
                          title={busyTitle}
                          disabled={disabled}
                          onClick={() => void stageRewindEntry(tabId, row.id, false)}
                        >
                          <IconRewind />
                        </button>
                        <button
                          type="button"
                          className="grid size-6 place-items-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:text-ink-faint"
                          aria-label={t("transcript.rewind.edit")}
                          title={busyTitle}
                          disabled={disabled}
                          onClick={() => void stageRewindEntry(tabId, row.id, true)}
                        >
                          <IconPencil />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="grid size-6 place-items-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:text-ink-faint"
                        aria-label={t("session.tree.navigate")}
                        title={busyTitle}
                        disabled={disabled}
                        onClick={() => void stageNavigate(tabId, row.id, summarize)}
                      >
                        <IconTreeBranch />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <label className="mt-3 flex items-center gap-2 text-xs text-ink-dim">
        <input
          type="checkbox"
          className="accent-copper"
          checked={summarize}
          onChange={(event) => setSummarize(event.target.checked)}
          disabled={disabled}
        />
        {t("session.tree.summarize")}
      </label>
    </Modal>
  );
}
