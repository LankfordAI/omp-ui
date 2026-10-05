// PROTOTYPE (#753): throwaway.
// Detection scenarios, Obsidian vault lists, the fixture transcript, the
// Obsidian URI builder, and the notes-touched derivation. Fixture note titles
// and bodies are invented; the repo is public.
import { useMemo } from "react";
import type { DiffRow } from "../../lib/omp-diff";
import type { NoticeItem, RenderItem, ToolItem } from "../../lib/transcript";
import type { Tone } from "../ui";
import { useStore } from "../../store";
import {
  getData,
  updateData,
  usePrototype753,
  usePrototypeData,
  vaultName,
  type ChoiceValue,
} from "./state";

export const VAULT_TOOL_NAME = "omp-ui_vault_write";
export const FIXTURE_PREFIX = "proto753-";
export const TOUCHED_NOTICE_ID = "proto753-touched";

/* ----------------------------------------------------------- detection */

/** One entry of `<userData>/obsidian.json` (#751). */
export interface ObsidianListEntry {
  /** 16-hex vault id: the key in obsidian.json. */
  id: string;
  path: string;
  open: boolean;
}

export interface DetectionRow {
  label: string;
  value: string;
  /** Mono detail after the value (a path or a desktop file). */
  detail?: string;
  tone: Tone;
  chip: string;
  hint?: string;
}

export interface DetectionScenario {
  rows: DetectionRow[];
  list: ObsidianListEntry[];
  /** False only under `noapp`: import is disabled. */
  appFound: boolean;
}

// This machine's obsidian.json at build time (2026-10-05). It moved since #750
// (IRE, d54189eae5e5b8ef): the vault id and path both changed.
const MACHINE_VAULT: ObsidianListEntry = {
  id: "ee8bdab8baa42089",
  path: "/home/alankford/Documents/Obsidian",
  open: true,
};

const CLI_HINT = "Optional. omp-ui works without it.";

export const DETECTION: Record<ChoiceValue<"p753_det">, DetectionScenario> = {
  machine: {
    appFound: true,
    list: [MACHINE_VAULT],
    rows: [
      { label: "Obsidian app", value: "Found", detail: "~/.config/obsidian", tone: "signal", chip: "found" },
      { label: "Vault list", value: "1 vault", tone: "signal", chip: "read" },
      { label: "Command line", value: "Registered", detail: "~/.local/bin/obsidian", tone: "signal", chip: "registered", hint: CLI_HINT },
      { label: "obsidian:// links", value: "Handled by", detail: "obsidian.desktop", tone: "signal", chip: "handled" },
    ],
  },
  nocli: {
    appFound: true,
    list: [MACHINE_VAULT],
    rows: [
      { label: "Obsidian app", value: "Found", detail: "~/.config/obsidian", tone: "signal", chip: "found" },
      { label: "Vault list", value: "1 vault", tone: "signal", chip: "read" },
      {
        label: "Command line",
        value: "Not registered",
        tone: "copper",
        chip: "not registered",
        hint: `Turn on Settings, General, Command line interface in Obsidian. ${CLI_HINT}`,
      },
      { label: "obsidian:// links", value: "Handled by", detail: "obsidian.desktop", tone: "signal", chip: "handled" },
    ],
  },
  noapp: {
    appFound: false,
    list: [],
    rows: [
      { label: "Obsidian app", value: "Not found", tone: "rose", chip: "not found" },
      { label: "Vault list", value: "None", tone: "neutral", chip: "none" },
      { label: "Command line", value: "None", tone: "neutral", chip: "none", hint: CLI_HINT },
      { label: "obsidian:// links", value: "No handler", tone: "copper", chip: "no handler" },
    ],
  },
  flatpak: {
    appFound: true,
    list: [MACHINE_VAULT],
    rows: [
      {
        label: "Obsidian app",
        value: "Found",
        detail: "~/.var/app/md.obsidian.Obsidian/config/obsidian",
        tone: "signal",
        chip: "found",
      },
      { label: "Vault list", value: "1 vault", tone: "signal", chip: "read" },
      { label: "Command line", value: "Registered", tone: "signal", chip: "registered", hint: CLI_HINT },
      { label: "obsidian:// links", value: "Handled by", detail: "md.obsidian.Obsidian.desktop", tone: "signal", chip: "handled" },
    ],
  },
};

/** The scenario's list entry for a registry path, if any. */
export function listEntryFor(scenario: DetectionScenario, path: string): ObsidianListEntry | undefined {
  const normalized = path.replace(/[/\\]+$/, "");
  return scenario.list.find((entry) => entry.path === normalized);
}

/* ----------------------------------------------------------------- URIs */

/** `obsidian://open?vault=<id>&file=<vault-relative path>` (#751); `.md` is stripped. */
export function vaultUri(vaultId: string, vaultRelativePath: string): string {
  const file = vaultRelativePath.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultId)}&file=${encodeURIComponent(file)}`;
}

/** Opens a whole vault: by id when known, else by absolute path. */
export function vaultRootUri(obsidianId: string | null, absolutePath: string): string {
  return obsidianId !== null
    ? `obsidian://open?vault=${encodeURIComponent(obsidianId)}`
    : `obsidian://open?path=${encodeURIComponent(absolutePath)}`;
}

/* ------------------------------------------------------- tool card args */

export type VaultAction = "create" | "append" | "edit";

export interface VaultWriteArgs {
  i: string;
  /** Display name (folder basename). */
  vault: string;
  /** Obsidian's 16-hex vault id. */
  vaultId: string;
  action: VaultAction;
  title: string;
  /** Vault-relative, inside the home folder. */
  path: string;
  /** Full note text for create (may carry YAML frontmatter). */
  content?: string;
  /** Appended text for append. */
  appended?: string;
  createdByOmpUi: boolean;
  /** Edit of a note omp-ui did not create. */
  diff?: DiffRow[];
}

/** Non-null only for prototype vault-write fixture items. */
export function vaultArgs(item: ToolItem): VaultWriteArgs | null {
  if (item.name !== VAULT_TOOL_NAME || !item.id.startsWith(FIXTURE_PREFIX)) return null;
  return item.args as VaultWriteArgs;
}

/** Splits leading YAML frontmatter into key/value pairs and the body. */
export function splitFrontmatter(text: string): { stamp: [string, string][]; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match === null) return { stamp: [], body: text };
  const stamp = match[1]!
    .split("\n")
    .map((line) => /^([^:]+):\s*(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!.trim(), m[2]!.trim()] as [string, string]);
  return { stamp, body: text.slice(match[0].length) };
}

/* ---------------------------------------------------------- transcript */

const T0 = Date.now();
const VAULT = vaultName(MACHINE_VAULT.path);

const DECISION_NOTE = `---
omp-ui: true
project: omp-ui
session: 7f3c9a1e
date: 2026-10-05
tags: [decision]
---
# Session HUD layout decision

The HUD keeps one line on desktop: liveness, title, context meter, then the action cluster. Anything that needs more than a glance moves into the inspector rail.

On the compact shell the header holds only the liveness badge, the console toggle, the browser pane toggle, and the kebab. Every other action lives in the session-actions sheet.

We chose this over a two-line HUD because the second line pushed the transcript down on short windows. See [[omp-ui/omp-ui Index]] for related notes.
`;

const READING_DIFF: DiffRow[] = [
  { kind: "ctx", lineNum: 3, text: "- [[Chromium offscreen rendering]]" },
  { kind: "ctx", lineNum: 4, text: "- [[Wayland compositor notes]]" },
  { kind: "del", lineNum: 5, text: "- [[Electon notes]]" },
  { kind: "add", lineNum: 5, text: "- [[Electron notes]]" },
];

function tool(id: string, args: VaultWriteArgs, resultText: string, offset: number): ToolItem {
  return {
    kind: "tool",
    id: `${FIXTURE_PREFIX}${id}`,
    toolCallId: `${FIXTURE_PREFIX}${id}`,
    name: VAULT_TOOL_NAME,
    args,
    status: "done",
    intent: args.i,
    resultText,
    timestamp: T0 - offset,
  };
}

/** Built once at module load so identities stay stable (TranscriptRow memoizes on item). */
export const FIXTURE_ITEMS: RenderItem[] = [
  {
    kind: "user",
    id: `${FIXTURE_PREFIX}u1`,
    text: "We settled the HUD layout. Write the decision into my vault and add it to the project index.",
    timestamp: T0 - 60_000,
  },
  {
    kind: "assistant",
    id: `${FIXTURE_PREFIX}a1`,
    text: "Writing the decision note, then linking it from the omp-ui index.",
    thinking: "",
    streaming: false,
    timestamp: T0 - 55_000,
  },
  tool(
    "t1",
    {
      i: "Writing the HUD layout decision",
      vault: VAULT,
      vaultId: MACHINE_VAULT.id,
      action: "create",
      title: "Session HUD layout decision",
      path: "omp-ui/Session HUD layout decision.md",
      content: DECISION_NOTE,
      createdByOmpUi: true,
    },
    `Created omp-ui/Session HUD layout decision.md in ${VAULT}`,
    50_000,
  ),
  tool(
    "t2",
    {
      i: "Linking the decision from the index",
      vault: VAULT,
      vaultId: MACHINE_VAULT.id,
      action: "append",
      title: "omp-ui Index",
      path: "omp-ui/omp-ui Index.md",
      appended: "- [[omp-ui/Session HUD layout decision]]",
      createdByOmpUi: true,
    },
    `Appended 1 line to omp-ui/omp-ui Index.md in ${VAULT}`,
    45_000,
  ),
  {
    kind: "user",
    id: `${FIXTURE_PREFIX}u2`,
    text: "Fix the broken link in omp-ui/Reading list.md too.",
    timestamp: T0 - 40_000,
  },
  tool(
    "t3",
    {
      i: "Fixing the broken link",
      vault: VAULT,
      vaultId: MACHINE_VAULT.id,
      action: "edit",
      title: "Reading list",
      path: "omp-ui/Reading list.md",
      createdByOmpUi: false,
      diff: READING_DIFF,
    },
    `Edited omp-ui/Reading list.md in ${VAULT} (1 line changed)`,
    35_000,
  ),
  {
    kind: "assistant",
    id: `${FIXTURE_PREFIX}a2`,
    text: `Done. Both notes are in ${VAULT} under omp-ui/.`,
    thinking: "",
    streaming: false,
    timestamp: T0 - 30_000,
  },
];

const TOUCHED_NOTICE: NoticeItem = {
  kind: "notice",
  id: TOUCHED_NOTICE_ID,
  text: "Vault notes touched this session",
};

/**
 * Appends the fixture transcript (and any "Add write" cards) after the real
 * items of a top-level rpc tab. Inert when the prototype is off.
 */
export function useVaultFixtureItems(base: RenderItem[]): RenderItem[] {
  const proto = usePrototype753();
  const { extraWrites } = usePrototypeData();
  return useMemo(
    () =>
      proto.active
        ? [...base, ...FIXTURE_ITEMS, ...extraWrites, ...(proto.touched === "notice" ? [TOUCHED_NOTICE] : [])]
        : base,
    [base, proto.active, proto.touched, extraWrites],
  );
}

/* ------------------------------------------------------- notes touched */

export interface TouchedNote {
  /** Latest card for this note: the scroll target. */
  itemId: string;
  title: string;
  path: string;
  vault: string;
  vaultId: string;
  action: VaultAction;
}

/** Done vault-write cards keyed by vault + path; latest action wins; first-touch order. */
export function touchedNotes(items: RenderItem[]): TouchedNote[] {
  const byKey = new Map<string, TouchedNote>();
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done") continue;
    const args = vaultArgs(item);
    if (args === null) continue;
    const key = `${args.vaultId}\u0000${args.path}`;
    const note: TouchedNote = {
      itemId: item.id,
      title: args.title,
      path: args.path,
      vault: args.vault,
      vaultId: args.vaultId,
      action: args.action,
    };
    // Map.set on an existing key keeps its original insertion position.
    byKey.set(key, note);
  }
  return [...byKey.values()];
}

const NO_ITEMS: RenderItem[] = [];

/** Notes touched in a tab: its real items plus the fixtures, derived from cards. */
export function useTouchedNotes(tabId: string): TouchedNote[] {
  const base = useStore((s) => s.rpc[tabId]?.items ?? NO_ITEMS);
  const items = useVaultFixtureItems(base);
  return useMemo(() => touchedNotes(items), [items]);
}

/** Scrolls the transcript to a card, the way the find bar does. */
export function scrollToCard(tabId: string, itemId: string): void {
  document
    .querySelector(`[data-tab-id="${CSS.escape(tabId)}"] [data-item-id="${CSS.escape(itemId)}"]`)
    ?.scrollIntoView({ block: "center" });
}

/* ------------------------------------------------------------ add write */

const EXTRA_TITLES = ["Compact shell lesson", "Rail section lesson", "Card density lesson", "Pane width lesson"];

/** Appends a running card whose content streams in over 1.5 s on a 100 ms timer, then settles. */
export function addVaultWrite(): void {
  const data = getData();
  const title = EXTRA_TITLES[data.extraWrites.length % EXTRA_TITLES.length]!;
  const vault = data.vaults.find((v) => v.id === data.defaultVaultId);
  const id = `${FIXTURE_PREFIX}extra-${Date.now().toString(36)}`;
  const full = `---
omp-ui: true
project: omp-ui
session: 7f3c9a1e
date: 2026-10-05
tags: [lesson]
---
# ${title}

A short lesson the agent filed while working. It records what went wrong, what fixed it, and where the fix lives.

Linked from [[omp-ui/omp-ui Index]].
`;
  const args: VaultWriteArgs = {
    i: `Writing ${title.toLowerCase()}`,
    vault: vault !== undefined ? vaultName(vault.path) : VAULT,
    vaultId: vault?.obsidianId ?? MACHINE_VAULT.id,
    action: "create",
    title,
    path: `${vault?.homeFolder ?? "omp-ui/"}${title}.md`,
    content: "",
    createdByOmpUi: true,
  };
  const item: ToolItem = {
    kind: "tool",
    id,
    toolCallId: id,
    name: VAULT_TOOL_NAME,
    args,
    status: "running",
    intent: args.i,
    timestamp: Date.now(),
  };
  const patch = (next: ToolItem): void =>
    updateData((prev) => ({ ...prev, extraWrites: prev.extraWrites.map((w) => (w.id === id ? next : w)) }));
  updateData((prev) => ({ ...prev, extraWrites: [...prev.extraWrites, item] }));
  const ticks = 15;
  let tick = 0;
  const timer = window.setInterval(() => {
    tick += 1;
    const content = full.slice(0, Math.ceil((full.length * tick) / ticks));
    if (tick < ticks) {
      patch({ ...item, args: { ...args, content } });
      return;
    }
    window.clearInterval(timer);
    patch({
      ...item,
      args: { ...args, content: full },
      status: "done",
      resultText: `Created ${args.path} in ${args.vault}`,
    });
  }, 100);
}
