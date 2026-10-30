import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ProjectOpenAvailability, ProjectOpenTarget } from "@omp-ui/core/types";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { fuzzyBest, highlightRuns } from "../lib/fuzzy";
import { currentLocaleId, useT } from "../lib/i18n";
import { formatHotkey, useHotkeys, type HotkeyMap } from "../lib/hotkeys";
import { identityWash } from "../lib/project-colors";
import { checkoutEntries, groupByRepository, projectIdentitySeed, type CheckoutEntry } from "../lib/repository-members";
import { useCompactShell } from "../lib/responsive";
import { isChatTab, useStore } from "../store";
import { Chevron, Chip, IconButton, IconSearch, Label, Modal } from "./ui";
import { ProjectMonogram } from "./ProjectMonogram";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "./palette";

/**
 * The project quick-open (issues #915, #919): the New session popup. The root
 * page holds one row per repository — the #903 merge, mirrored from
 * NewSessionDialog's here face — plus No project (a chat) and the add-project
 * rows, ordered so a bare Enter repeats "another one of these" for the focused
 * tab. ArrowRight at the end of the box (or a row's trailing button) drills
 * into a page: a project page holds every project action (spawn variants, open
 * targets, Lab, settings, remove), the No project page the chat variants.
 * Backspace on an empty box walks back out — page to root, root to closed —
 * which is why the input's onKeyDown filters those chords before delegating
 * to the palette nav.
 */

/** One launch target: a project path as owned by one instance (null = here). */
interface Pair {
  projectCwd: string;
  instanceId: string | null;
}

type RowKind = "chat" | "project" | "add" | "action";

interface QuickRow {
  id: string;
  /** Section header; null rows (Chat/Add/actions) render without one. */
  group: string | null;
  label: string;
  sub?: string;
  title?: string;
  hits: number[];
  kind: RowKind;
  pair?: Pair;
  score?: number;
  /** Position in the empty-query order; the tie-breaker when scoring. */
  index: number;
  /** Every checkout merged into this row (#903); drives focused-row matching. */
  members?: Pair[];
  /** kind "project": the icon `data:` URL (#1000); null = initials. */
  icon?: string | null;
  /** kind "add": the instance the project is registered on; null = this app. */
  addOn?: string | null;
  /** kind "action": runs after the overlay closes. */
  run?: () => void;
  /** kind "action": destructive styling (Remove project). */
  danger?: boolean;
}

type Page =
  | { kind: "root" }
  | { kind: "project"; row: QuickRow }
  | { kind: "chat" };

const UNAVAILABLE: ProjectOpenAvailability = { vsCode: false, terminal: false };

export function ProjectQuickOpen() {
  const seed = useStore((s) => s.projectQuickOpen);
  const closeProjectQuickOpen = useStore((s) => s.closeProjectQuickOpen);
  const state = useStore((s) => s.state);
  const focused = useStore((s) => s.tabs.find((tab) => tab.tabId === s.activeTabId) ?? null);
  const newSession = useStore((s) => s.newSession);
  const newChat = useStore((s) => s.newChat);
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const openNewSessionDialog = useStore((s) => s.openNewSessionDialog);
  const openLab = useStore((s) => s.openLab);
  const openExperimentDialog = useStore((s) => s.openExperimentDialog);
  const openProjectSettings = useStore((s) => s.openProjectSettings);
  const removeProject = useStore((s) => s.removeProject);
  const openCopyProjectDialog = useStore((s) => s.openCopyProjectDialog);
  const reportError = useStore((s) => s.reportError);
  const t = useT();
  const localeId = currentLocaleId();
  const compact = useCompactShell();

  // The seed query is consumed at mount: App mounts this overlay only while
  // `projectQuickOpen !== null`, so a re-open always remounts with its seed.
  const [query, setQuery] = useState(seed?.query ?? "");
  const [page, setPage] = useState<Page>({ kind: "root" });
  /** The root page's query, restored on Back. */
  const rootQueryRef = useRef("");
  const [availability, setAvailability] = useState<ProjectOpenAvailability | null>(null);
  const availabilityAsked = useRef(false);
  const mounted = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    inputRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  const nicknames = useMemo(
    () => new Map((state?.remoteInstances ?? []).map((instance) => [instance.id, instance.nickname])),
    [state],
  );

  const close = useCallback(() => closeProjectQuickOpen(), [closeProjectQuickOpen]);

  const baseRows = useMemo<QuickRow[]>(() => {
    // The repository merge (issue #903 rule, mirrored from hereGroups): one
    // row per repositoryKey; lib/repository-members owns the grouping so the
    // composer's machine chip derives the same members.
    const groups = groupByRepository(checkoutEntries(state));
    // A merged row's subline names every machine holding a checkout (#936):
    // local first, then member order, each machine once (twins collapse).
    const machineList = (members: readonly CheckoutEntry[]): string => {
      const ids = [...new Set(members.map((m) => m.instanceId))].sort(
        (a, b) => Number(a !== null) - Number(b !== null),
      );
      return ids
        .map((id) => (id === null ? t("quickopen.host.local") : (nicknames.get(id) ?? id)))
        .join(" · ");
    };

    const focusedInstanceId = focused?.instanceId ?? null;

    const projectRows: QuickRow[] = groups.map((group) => {
      // Target pair (the Q3 rule): the local checkout wins, else the instance
      // holding the focused tab, else registry order. The target names the row
      // and decides which host the subline shows.
      const target =
        group.members.find((m) => m.instanceId === null) ??
        (focusedInstanceId !== null ? group.members.find((m) => m.instanceId === focusedInstanceId) : undefined) ??
        group.members[0]!;
      return {
        id: projectIdentitySeed({ repositoryKey: group.key, instanceId: target.instanceId, projectCwd: target.projectCwd }),
        group: t("quickopen.group.projects"),
        label: target.name,
        sub:
          group.members.length === 1
            ? target.instanceId === null
              ? t("quickopen.host.local")
              : `${nicknames.get(target.instanceId) ?? target.instanceId} · ${target.projectCwd}`
            : machineList(group.members),
        title: group.members.length === 1 ? target.title : group.members.map((m) => m.projectCwd).join("\n"),
        hits: [],
        kind: "project",
        pair: { projectCwd: target.projectCwd, instanceId: target.instanceId },
        // The target names the row, so its icon leads; a merged row falls
        // back to any member's icon (#1000).
        icon: target.icon ?? group.members.find((m) => m.icon !== null)?.icon ?? null,
        index: 0,
        members: group.members.map((m) => ({ projectCwd: m.projectCwd, instanceId: m.instanceId })),
      };
    });

    const chatRow: QuickRow = {
      id: "chat",
      group: null,
      label: t("quickopen.noproject"),
      sub: t("quickopen.noproject.desc"),
      hits: [],
      kind: "chat",
      index: 0,
    };

    // A focused project tab's repository leads, then No project (issue #919),
    // so a bare Enter repeats "another one of these". Keyed groups match by
    // membership, so a remote twin of the focused checkout still promotes the
    // merged row; keyless rows match on path. A focused chat, or nothing,
    // puts No project first.
    const leadCwd = focused !== null && !isChatTab(state, focused.tabId) ? focused.projectCwd : null;
    const lead =
      leadCwd === null
        ? -1
        : projectRows.findIndex((row) => row.members?.some((m) => m.projectCwd === leadCwd) === true);
    const out: QuickRow[] =
      lead < 0
        ? [chatRow, ...projectRows]
        : [projectRows[lead]!, chatRow, ...projectRows.filter((_, j) => j !== lead)];

    out.push({ id: "add", group: null, label: t("quickopen.add"), hits: [], kind: "add", index: 0, addOn: null });
    for (const instance of state?.remoteInstances ?? []) {
      if (instance.status !== "joined") continue;
      out.push({
        id: `add:${instance.id}`,
        group: null,
        label: t("remoteinstances.action.registerProject", { nickname: instance.nickname }),
        hits: [],
        kind: "add",
        index: 0,
        addOn: instance.id,
      });
    }
    return out.map((row, i) => ({ ...row, index: i }));
  }, [focused, state, nicknames, t, localeId]);

  // The page's row as of the latest broadcast (a membership change re-derives
  // it); the stored snapshot only stands in until the reset effect fires.
  const pageRow =
    page.kind === "project" ? (baseRows.find((row) => row.id === page.row.id) ?? page.row) : null;

  // A project removed by a broadcast while its page is up: back to root.
  useEffect(() => {
    if (page.kind !== "project" || baseRows.some((row) => row.id === page.row.id)) return;
    setPage({ kind: "root" });
    setQuery(rootQueryRef.current);
  }, [page, baseRows]);

  const experimentsEnabled = state?.experimentsEnabled === true;

  const actionRows = useMemo<QuickRow[]>(() => {
    const rows: QuickRow[] = [];
    const action = (id: string, label: string, run: () => void, extra: { sub?: string; danger?: boolean } = {}): void => {
      rows.push({ id, group: null, label, hits: [], kind: "action", index: rows.length, run, ...extra });
    };
    if (page.kind === "chat") {
      action("chat:new", t("palette.action.newChat"), () => void newChat());
      action("chat:private", t("palette.action.newPrivateChat"), () => void newChat({ private: true }));
      return rows;
    }
    if (pageRow?.pair === undefined) return rows;
    const { projectCwd: p, instanceId: i } = pageRow.pair;
    action("newSession", t("project.actions.newSession"), () => void newSession(p, undefined, i));
    action("newTerminal", t("project.actions.newTerminal"), () => void newSession(p, "pty", i));
    action("newPrivate", t("project.actions.newPrivate"), () => void newSession(p, undefined, i, { private: true }));
    action("newSessionDialog", t("project.actions.newSessionDialog"), () =>
      openNewSessionDialog({ projectCwd: p, instanceId: i }),
    );
    // Open targets are host-local launches: never for a remote checkout, and
    // the compact shell has no desktop to hand them to.
    if (i === null && !compact) {
      const openIn = (target: ProjectOpenTarget, label: string): void => {
        action(`open:${target}`, t("quickopen.action.openIn", { target: label }), () => {
          void backend.openProject(p, target).catch(reportError);
        });
      };
      if (availability?.vsCode === true) openIn("vscode", "VS Code");
      openIn("files", t("project.open.files"));
      if (availability?.terminal === true) openIn("terminal", t("project.open.terminal"));
    }
    if (experimentsEnabled) {
      action("lab", t("project.actions.lab"), () => openLab(p, i));
      action("newExperiment", t("project.actions.newExperiment"), () => openExperimentDialog(p, i));
    }
    action("settings", t("project.actions.settings"), () => openProjectSettings(p, i));
    // Project copy (issue #992): this computer's checkout only, while at
    // least one joined member could receive it.
    const label = pageRow.label;
    if (i === null && (state?.remoteInstances ?? []).some((instance) => instance.status === "joined")) {
      action("copyTo", t("project.actions.copyTo"), () => openCopyProjectDialog(p, label));
    }
    // The store owns the confirmation.
    action("remove", t("project.actions.remove"), () => void removeProject(p, i), { danger: true });
    return rows;
  }, [
    page.kind,
    pageRow,
    compact,
    availability,
    experimentsEnabled,
    newChat,
    newSession,
    openNewSessionDialog,
    openLab,
    openExperimentDialog,
    openProjectSettings,
    removeProject,
    openCopyProjectDialog,
    state,
    reportError,
    t,
    localeId,
  ]);

  // Flat, already-ordered result list; group headers derive from it so the
  // arrow-key index and the rendered rows can never disagree.
  const results = useMemo<QuickRow[]>(() => {
    const rows = page.kind === "root" ? baseRows : actionRows;
    const needle = query.trim();
    if (needle.length === 0) return rows;
    const scored: { row: QuickRow; score: number }[] = [];
    for (const row of rows) {
      // Every merged checkout's path is a search field (issue #915): typing
      // any host's directory fragment must find the group row, even when the
      // row itself shows the local pair. Only the label reports hit indices —
      // emphasising a truncated subline is noise. Action rows match on the
      // label alone.
      const fields: { text: string; weight: number; report?: boolean }[] = [
        { text: row.label, weight: 1 },
      ];
      if (row.kind === "project" && row.members !== undefined) {
        for (const path of new Set(row.members.map((m) => m.projectCwd))) {
          fields.push({ text: path, weight: 0.5, report: false });
        }
      }
      const hit = fuzzyBest(needle, fields);
      if (hit !== null) scored.push({ row: { ...row, hits: hit.hits, score: hit.score }, score: hit.score });
    }
    // Ties keep the empty-query order, the lead row included.
    scored.sort((a, b) => b.score - a.score || a.row.index - b.row.index);
    return scored.map((s) => s.row);
  }, [page.kind, baseRows, actionRows, query]);

  const pick = useCallback(
    (row: QuickRow): void => {
      // Close first, run after: the overlay must never outlive the pick it
      // just committed, even while the spawn timeout burns inside newSession.
      close();
      if (row.kind === "action") row.run!();
      else if (row.kind === "chat") void newChat();
      else if (row.kind === "add") openProjectPicker(row.addOn ?? null);
      else if (row.pair !== undefined) void newSession(row.pair.projectCwd, undefined, row.pair.instanceId);
    },
    [close, newChat, openProjectPicker, newSession],
  );

  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: results,
    resetKey: `${page.kind}:${query}`,
    onPick: pick,
    onClose: close,
    // Shift+Enter on a root project row opens the New session dialog for that
    // pair instead of spawning — the quick-open is also the dialog's shortcut (issue #915).
    onEnter: (e: ReactKeyboardEvent): boolean => {
      if (!e.shiftKey || page.kind !== "root") return false;
      const row = results[active];
      if (row === undefined || row.kind !== "project" || row.pair === undefined) return false;
      close();
      openNewSessionDialog({ projectCwd: row.pair.projectCwd, instanceId: row.pair.instanceId });
      return true;
    },
  });

  function openPage(row: QuickRow): void {
    rootQueryRef.current = query;
    setQuery("");
    if (row.kind === "chat") {
      setPage({ kind: "chat" });
    } else {
      setPage({ kind: "project", row });
      // Open targets are asked once per mount, and only when they could show.
      if (row.pair?.instanceId === null && !compact && availability === null && !availabilityAsked.current) {
        availabilityAsked.current = true;
        backend.getProjectOpenAvailability().then(
          (answer) => {
            if (mounted.current) setAvailability(answer);
          },
          () => {
            // A failed discovery channel reads as "optional integrations
            // unavailable"; Files stays usable (the Sidebar's old fallback).
            if (mounted.current) setAvailability(UNAVAILABLE);
          },
        );
      }
    }
    inputRef.current?.focus();
  }

  function goRoot(): void {
    setPage({ kind: "root" });
    setQuery(rootQueryRef.current);
    inputRef.current?.focus();
  }

  function handleInputKey(event: ReactKeyboardEvent<HTMLInputElement>): void {
    // Backspace on an empty box walks back out — a page to root, root out of
    // the overlay — rather than silently deleting nothing (issue #915).
    if (event.key === "Backspace" && query === "") {
      event.preventDefault();
      if (page.kind === "root") close();
      else goRoot();
      return;
    }
    // ArrowRight at the end of the box drills into the active row's page;
    // anywhere else it only moves the caret.
    if (event.key === "ArrowRight" && page.kind === "root" && event.currentTarget.selectionStart === query.length) {
      const row = results[active];
      if (row !== undefined && (row.kind === "project" || row.kind === "chat")) {
        event.preventDefault();
        openPage(row);
        return;
      }
    }
    handleKey(event);
  }

  // mod+1…mod+9 fire the first nine root rows while the box is empty. The map
  // is a fresh literal each render — `useHotkeys` keeps a latest-ref either way.
  const positional: HotkeyMap = {};
  for (let i = 0; i < 9; i += 1) {
    positional[`mod+${i + 1}`] = (e: KeyboardEvent): void => {
      const row = baseRows[i];
      // Inert while closed, on a page, or mid-typing: return without
      // preventDefault so the chord stays available to the rest of the shell.
      if (seed === null || page.kind !== "root" || row === undefined || query.trim() !== "") return;
      e.preventDefault();
      pick(row);
    };
  }
  useHotkeys(positional);

  if (seed === null) return null;

  const onRoot = page.kind === "root";
  const emptyQuery = query.trim() === "";
  let lastGroup: string | null = null;

  return (
    <Modal onClose={close} width="w-[34rem]">
      <PaletteSearchHeader>
        {onRoot ? (
          <IconSearch className="size-4 shrink-0 text-ink-dim" />
        ) : (
          <>
            <IconButton label={t("quickopen.page.back")} onClick={goRoot}>
              <Chevron open={false} className="rotate-180" />
            </IconButton>
            {/* Project pages wash the header chip with the project's identity
                hue; the chat page keeps the neutral chip. */}
            <Chip
              truncate
              className="max-w-[12rem]"
              style={page.kind === "project" ? identityWash(pageRow?.id ?? "") : undefined}
            >
              {pageRow?.label ?? t("quickopen.noproject")}
            </Chip>
          </>
        )}
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={onRoot ? t("quickopen.search.placeholder") : t("quickopen.actions.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={handleInputKey}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {!compact && <Chip mono>{formatHotkey("escape")}</Chip>}
      </PaletteSearchHeader>

      <PaletteList>
        {results.length === 0 && (
          <PaletteEmpty title={t("palette.empty.title")} hint={t("palette.empty.hint")} />
        )}
        {results.map((row, i) => {
          const header = row.group !== null && row.group !== lastGroup ? row.group : null;
          lastGroup = row.group;
          const drillable = onRoot && (row.kind === "project" || row.kind === "chat");
          return (
            <div key={row.id}>
              {header !== null && (
                <Label className="mt-1.5 block px-3.5 pb-1 pt-1.5 first:mt-0">{header}</Label>
              )}
              {/* Siblings, never nested: the drill-in button sits beside the row button. */}
              <div
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex items-center transition-colors",
                  drillable && "pr-2",
                  i === active ? "bg-hover" : "hover:bg-hover/50",
                )}
              >
                <button
                  type="button"
                  ref={i === active ? activeRef : null}
                  onClick={() => pick(row)}
                  title={row.title}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-1.5 text-left"
                >
                  {row.kind === "project" ? (
                    // The monogram box, so the row reads as the same
                    // repository the session rows name.
                    <ProjectMonogram seed={row.id} name={row.label} icon={row.icon ?? null} />
                  ) : (
                    <span
                      className={cn(
                        "h-3.5 w-0.5 shrink-0 rounded-full",
                        i === active ? "bg-signal" : "bg-transparent",
                      )}
                    />
                  )}
                  <span className={cn("min-w-0 flex-1 truncate text-xs", row.danger === true ? "text-rose" : "text-ink")}>
                    {highlightRuns(row.label, row.hits).map((run, r) =>
                      run.hit ? (
                        <mark key={r} className="bg-transparent font-semibold text-signal">
                          {run.text}
                        </mark>
                      ) : (
                        <span key={r}>{run.text}</span>
                      ),
                    )}
                  </span>
                  {row.sub !== undefined && (
                    <span className="min-w-0 max-w-[16rem] shrink-0 truncate text-[11px] text-ink-dim">
                      {row.sub}
                    </span>
                  )}
                  {onRoot && emptyQuery && i < 9 && <Chip mono>{formatHotkey(`mod+${i + 1}`)}</Chip>}
                </button>
                {drillable && (
                  <IconButton label={t("quickopen.project.actions", { name: row.label })} onClick={() => openPage(row)}>
                    <Chevron open={false} />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
      </PaletteList>

      <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-ink-faint">
        <span className="font-mono">{formatHotkey("arrowup")}{formatHotkey("arrowdown")}</span>
        <span>{t("quickopen.footer.navigate")}</span>
        <span className="font-mono">{formatHotkey("enter")}</span>
        <span>{t("quickopen.footer.select")}</span>
        {onRoot && (
          <>
            <span className="font-mono">{formatHotkey("arrowright")}</span>
            <span>{t("quickopen.footer.actions")}</span>
          </>
        )}
        <span className="font-mono">{formatHotkey("backspace")}</span>
        <span>{t("quickopen.footer.back")}</span>
        <span className="font-mono">{formatHotkey("escape")}</span>
        <span>{t("quickopen.footer.close")}</span>
      </div>
    </Modal>
  );
}
