import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryOverview,
  MemoryRow,
  MemoryScope,
} from "@omp-ui/core/types";
import { backend } from "../backend";
import { findRecord, useStore } from "../store";
import { compactNum, IconRefresh } from "./SessionHud";
import { Button, Chip, ChoiceCapsule, ConfirmDialog, Disclosure, Empty, IconButton, Panel } from "./ui";

/**
 * The memory pane: a view of the project's mnemopi store, not of any live
 * session (ADR-0017, issue #206). It reads and edits what the agent retained
 * across sessions — the durable banks on disk — so it deliberately has no
 * store slice and no polling: like DiffsPane, everything is local load-union
 * state fetched on mount and on explicit refresh, because the main process
 * reads the SQLite banks statelessly and there is no push channel to follow.
 */

/** One page per fetch; "Load more" appends the next offset. */
const PAGE_SIZE = 50;

interface OverviewLoad {
  status: "idle" | "loading" | "error" | "loaded";
  message?: string;
  overview?: MemoryOverview;
}

interface ListLoad {
  status: "idle" | "loading" | "error" | "loaded";
  message?: string;
  rows: MemoryRow[];
  total: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDbSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const INPUT_CLASS =
  "rounded border border-line bg-void px-1.5 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";

const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-line bg-void px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";

/**
 * Fetches the full (unclipped) content on mount — rendered inside a
 * Disclosure, so mounting *is* the first open — and hands it up so the
 * clipped block swaps to the full text.
 */
function FullContentLoader({
  projectCwd,
  scope,
  id,
  onLoaded,
}: {
  projectCwd: string;
  scope: MemoryScope;
  id: string;
  onLoaded: (content: string) => void;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    backend
      .memoryGet(projectCwd, scope, id)
      .then((row) => {
        if (stale) return;
        if (row === null) setFailed("memory no longer exists");
        else onLoaded(row.content);
      })
      .catch((err: unknown) => {
        if (!stale) setFailed(errorMessage(err));
      });
    return () => {
      stale = true;
    };
    // Deps are stable in practice: a Disclosure child mounts once per open,
    // and onLoaded is a state setter.
  }, [projectCwd, scope, id, onLoaded]);
  return (
    <p className="py-1 text-[11px] text-ink-faint">
      {failed ?? "loading full memory…"}
    </p>
  );
}

function MemoryRowCard({
  row,
  projectCwd,
  scope,
  onMutated,
}: {
  row: MemoryRow;
  projectCwd: string;
  scope: MemoryScope;
  onMutated: () => void;
}) {
  /** Full unclipped content once fetched; replaces the clipped display. */
  const [full, setFull] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const content = full ?? row.content;
  const editable = row.store === "working";

  const startEdit = async (): Promise<void> => {
    // Editing the clip would silently truncate the memory on commit, so a
    // truncated row fetches the full text before the textarea opens.
    let text = content;
    if (row.truncated && full === null) {
      try {
        const got = await backend.memoryGet(projectCwd, scope, row.id);
        if (got !== null) {
          text = got.content;
          setFull(got.content);
        }
      } catch (err) {
        window.alert(errorMessage(err));
        return;
      }
    }
    setDraft(text);
    setEditing(true);
  };

  const commitEdit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await backend.memoryUpdate(projectCwd, scope, row.id, { content: draft });
      if (result.status !== "ok") {
        window.alert(`Could not update this memory: ${result.status}`);
        return;
      }
      setFull(draft);
      setEditing(false);
      onMutated();
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await backend.memoryForget(projectCwd, scope, row.id);
      if (result.status !== "ok") {
        window.alert(`Could not forget this memory: ${result.status}`);
        return;
      }
      setConfirming(false);
      onMutated();
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const date = (row.timestamp ?? row.createdAt)?.slice(0, 10);

  return (
    <Panel className="px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <Chip mono>{row.store}</Chip>
        {row.importance !== null && (
          <Chip mono title="importance">{row.importance.toFixed(1)}</Chip>
        )}
        {!editable && <Chip title="episodic memories are consolidated history and cannot be edited">read-only</Chip>}
        <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint" title={row.source ?? undefined}>
          {row.source}
        </span>
        {date !== undefined && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{date}</span>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            rows={4}
            value={draft}
            aria-label="edit memory"
            onChange={(e) => setDraft(e.target.value)}
            className={TEXTAREA_CLASS}
          />
          <div className="mt-1 flex items-center justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              cancel
            </Button>
            <Button
              size="xs"
              variant="solid"
              disabled={busy || draft.trim().length === 0}
              onClick={() => void commitEdit()}
            >
              save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div data-selectable className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-mid">
            {content}
          </div>
          {row.truncated && full === null && (
            <Disclosure
              className="mt-1"
              summary={<span className="text-[11px]">show full memory</span>}
            >
              <FullContentLoader
                projectCwd={projectCwd}
                scope={scope}
                id={row.id}
                onLoaded={setFull}
              />
            </Disclosure>
          )}
          {editable && (
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => void startEdit()}>
                edit
              </Button>
              <Button size="xs" variant="ghost" tone="rose" onClick={() => setConfirming(true)}>
                forget
              </Button>
            </div>
          )}
        </>
      )}
      {confirming && (
        <ConfirmDialog
          kicker="Irreversible action"
          title="Forget this memory?"
          tone="rose"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
              <Button variant="solid" tone="rose" disabled={busy} onClick={() => void forget()}>
                Forget memory
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-ink-mid">
            The memory and its derived facts, embeddings, and graph edges are
            deleted from the bank. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

export function MemoryPane({ tabId }: { tabId: string }) {
  const projectCwd = useStore((s) => findRecord(s.state, tabId)?.projectCwd);

  const [overview, setOverview] = useState<OverviewLoad>({ status: "idle" });
  const [scope, setScope] = useState<MemoryScope>("project");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [list, setList] = useState<ListLoad>({ status: "idle", rows: [], total: 0 });
  /** Bumped to force a list refetch after refresh/mutations. */
  const [revision, setRevision] = useState(0);
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);

  const overviewRequestRef = useRef(0);
  const listRequestRef = useRef(0);

  const refreshOverview = useCallback(async () => {
    const requestId = ++overviewRequestRef.current;
    if (!projectCwd) return;
    if (requestId === overviewRequestRef.current) setOverview({ status: "loading" });
    try {
      const result = await backend.memoryOverview(projectCwd);
      if (requestId !== overviewRequestRef.current) return;
      setOverview({ status: "loaded", overview: result });
    } catch (err) {
      if (requestId !== overviewRequestRef.current) return;
      setOverview({ status: "error", message: errorMessage(err) });
    }
  }, [projectCwd]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  const ov = overview.status === "loaded" ? overview.overview : undefined;

  // The project option only exists once a session has created a bank; until
  // then the pane silently reads the global bank instead of a dead end.
  useEffect(() => {
    if (ov !== undefined && ov.project === null && scope === "project") setScope("global");
  }, [ov, scope]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const ready =
    projectCwd !== undefined &&
    ov !== undefined &&
    ov.backend === "mnemopi" &&
    ov.error === null &&
    (scope === "global" || ov.project !== null);

  const fetchPage = useCallback(
    async (offset: number) => {
      const requestId = ++listRequestRef.current;
      if (!projectCwd) return;
      if (offset === 0 && requestId === listRequestRef.current) {
        setList((prev) => ({ ...prev, status: "loading" }));
      }
      try {
        const page = await backend.memoryList(projectCwd, scope, {
          query: debouncedQuery.trim() === "" ? null : debouncedQuery,
          offset,
          limit: PAGE_SIZE,
        });
        if (requestId !== listRequestRef.current) return;
        setList((prev) => ({
          status: "loaded",
          rows: offset === 0 ? page.rows : [...prev.rows, ...page.rows],
          total: page.total,
        }));
      } catch (err) {
        if (requestId !== listRequestRef.current) return;
        setList((prev) => ({ ...prev, status: "error", message: errorMessage(err) }));
      }
    },
    [projectCwd, scope, debouncedQuery],
  );

  useEffect(() => {
    if (!ready) return;
    void fetchPage(0);
  }, [ready, fetchPage, revision]);

  const refreshAll = (): void => {
    void refreshOverview();
    setRevision((r) => r + 1);
  };

  const remember = async (): Promise<void> => {
    if (!projectCwd) return;
    const text = addText.trim();
    if (text === "") return;
    setAdding(true);
    try {
      await backend.memoryAdd(projectCwd, scope, text);
      setAddText("");
      refreshAll();
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const enableMnemopi = async (): Promise<void> => {
    try {
      await backend.writeOmpSetting("memory.backend", "mnemopi");
      await backend.writeOmpSetting("mnemopi.scoping", "per-project-tagged");
      // Auto-learn rides along (issue #207): it only adds the learn/manage_skill
      // tools plus standing guidance — autoContinue stays off, so no extra
      // capture turns are silently opted into.
      await backend.writeOmpSetting("autolearn.enabled", true);
    } catch (err) {
      window.alert(errorMessage(err));
      return;
    }
    void refreshOverview();
  };

  if (!projectCwd) {
    return <Empty title="No project" hint="This tab has no project directory to read memory for." />;
  }
  if (overview.status === "idle" || overview.status === "loading") {
    return <Empty title="Reading memory…" hint="Inspecting the memory banks on disk." />;
  }
  if (overview.status === "error" || ov === undefined) {
    return (
      <Empty
        title="Could not read memory"
        hint={overview.message}
        action={
          <Button size="xs" onClick={() => void refreshOverview()}>
            retry
          </Button>
        }
      />
    );
  }
  if (ov.error !== null) {
    return (
      <Empty
        title="Could not read memory"
        hint={ov.error}
        action={
          <Button size="xs" onClick={() => void refreshOverview()}>
            retry
          </Button>
        }
      />
    );
  }
  if (ov.backend !== "mnemopi") {
    return (
      <Empty
        title={ov.backend === "off" ? "memory is off" : `memory backend: ${ov.backend}`}
        hint="This pane browses and edits the mnemopi memory banks the agent retains across sessions. Enabling also turns on auto-learn, which lets the agent capture reusable lessons and skills. Applies to sessions started after this change."
        action={
          <Button size="xs" variant="solid" onClick={() => void enableMnemopi()}>
            Enable Mnemopi memory
          </Button>
        }
      />
    );
  }

  const bank = scope === "global" ? ov.global : ov.project;
  const noProjectBank = scope === "project" && ov.project === null;
  const showAddBox = !noProjectBank;

  return (
    <div>
      <div className="border-b border-line-soft px-3 py-2">
        <div className="flex items-center gap-1.5">
          <ChoiceCapsule
            label="scope"
            value={scope}
            onChange={setScope}
            options={[
              {
                value: "project",
                label: "project",
                disabled: ov.project === null,
                title: ov.project === null ? "no project memory yet" : undefined,
              },
              { value: "global", label: "global" },
            ]}
          />
          <input
            value={query}
            placeholder="search memories…"
            aria-label="search memories"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            className={`min-w-0 flex-1 ${INPUT_CLASS}`}
          />
          <IconButton label="refresh memory" onClick={refreshAll}>
            <IconRefresh />
          </IconButton>
        </div>
        {bank !== null && (
          <span
            className="mt-1.5 block truncate font-mono text-[10px] tabular-nums text-ink-faint"
            title={bank.dbPath}
          >
            {bank.bank} · {compactNum(bank.workingCount)} working · {compactNum(bank.episodicCount)} episodic · {formatDbSize(bank.sizeBytes)}
          </span>
        )}
      </div>

      {showAddBox && (
        <div className="border-b border-line-soft px-3 py-2">
          <textarea
            rows={2}
            value={addText}
            placeholder={`remember something in the ${scope} bank…`}
            aria-label="new memory"
            onChange={(e) => setAddText(e.target.value)}
            className={TEXTAREA_CLASS}
          />
          <div className="mt-1 flex justify-end">
            <Button
              size="xs"
              variant="solid"
              disabled={adding || addText.trim() === ""}
              onClick={() => void remember()}
            >
              Remember
            </Button>
          </div>
        </div>
      )}

      {noProjectBank ? (
        <Empty
          title="no project memory yet"
          hint="memory banks are created by the first session that runs with memory enabled"
        />
      ) : list.status === "idle" || list.status === "loading" ? (
        <Empty title="Reading memories…" hint="Querying the memory bank." />
      ) : list.status === "error" ? (
        <Empty
          title="Could not list memories"
          hint={list.message}
          action={
            <Button size="xs" onClick={() => void fetchPage(0)}>
              retry
            </Button>
          }
        />
      ) : list.rows.length === 0 ? (
        <Empty
          title={debouncedQuery.trim() === "" ? "Nothing retained yet" : "No matches"}
          hint="refresh to see what the agent retained"
        />
      ) : (
        <div className="space-y-2 px-3 py-2.5">
          {list.rows.map((row) => (
            <MemoryRowCard
              key={row.id}
              row={row}
              projectCwd={projectCwd}
              scope={scope}
              onMutated={() => setRevision((r) => r + 1)}
            />
          ))}
          {list.rows.length < list.total && (
            <div className="flex justify-center pt-0.5">
              <Button size="xs" onClick={() => void fetchPage(list.rows.length)}>
                Load more · {list.rows.length} of {list.total}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
