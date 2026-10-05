// PROTOTYPE (#753): throwaway.
// Activation gate, URL-backed variant choices, and the prototype data store
// (vault registry, knowledge homes, extra writes) in localStorage. Module-level
// external stores read via useSyncExternalStore, following
// prototype-browser-pane/state.ts at ba9e17c.
import { useSyncExternalStore } from "react";
import type { ToolItem } from "../../lib/transcript";

/**
 * `--pane` serves a production web build, so import.meta.env.DEV is false
 * there; an explicit VITE_ flag gates instead. Vitest runs with MODE "test",
 * so the suite never sees the prototype.
 */
export const PROTOTYPE_753: boolean =
  import.meta.env.VITE_OMP_UI_PROTOTYPE_753 === "1" && import.meta.env.MODE !== "test";

/* ------------------------------------------------------------- choices */

export const CHOICES = {
  p753_reg: ["page", "memory"],
  p753_chip: ["tab", "header"],
  p753_card: ["full", "compact", "note"],
  p753_mark: ["border", "banner"],
  p753_touched: ["hud", "rail", "notice"],
  p753_det: ["machine", "nocli", "noapp", "flatpak"],
} as const;

export type ChoiceKey = keyof typeof CHOICES;
export type ChoiceValue<K extends ChoiceKey> = (typeof CHOICES)[K][number];

/** Starting defaults are the plan's recommendations; each answer re-marks its line. */
const DEFAULTS: { [K in ChoiceKey]: ChoiceValue<K> } = {
  p753_reg: "page", // Q1 answered (a): own Settings page "Knowledge vault" after Memory.
  p753_chip: "tab", // Q2 answered (a): last Project settings tab "Knowledge".
  p753_card: "full", // Q3 answered (a): full card, ToolCard geometry, preview open.
  p753_mark: "border",
  p753_touched: "rail",
  p753_det: "machine",
};

export interface Prototype753 {
  active: boolean;
  reg: ChoiceValue<"p753_reg">;
  chip: ChoiceValue<"p753_chip">;
  card: ChoiceValue<"p753_card">;
  mark: ChoiceValue<"p753_mark">;
  touched: ChoiceValue<"p753_touched">;
  det: ChoiceValue<"p753_det">;
}

const choiceListeners = new Set<() => void>();

function subscribeChoices(listener: () => void): () => void {
  choiceListeners.add(listener);
  return () => {
    choiceListeners.delete(listener);
  };
}

function pick<K extends ChoiceKey>(params: URLSearchParams, key: K): ChoiceValue<K> {
  const raw = params.get(key) ?? "";
  return (CHOICES[key] as readonly string[]).includes(raw) ? (raw as ChoiceValue<K>) : DEFAULTS[key];
}

const INACTIVE: Prototype753 = {
  active: false,
  reg: DEFAULTS.p753_reg,
  chip: DEFAULTS.p753_chip,
  card: DEFAULTS.p753_card,
  mark: DEFAULTS.p753_mark,
  touched: DEFAULTS.p753_touched,
  det: DEFAULTS.p753_det,
};

let cachedSearch: string | null = null;
let cachedChoices: Prototype753 = INACTIVE;

/** Snapshot is identity-stable until the query string changes. */
export function readChoices(): Prototype753 {
  if (!PROTOTYPE_753) return INACTIVE;
  const search = window.location.search;
  if (search !== cachedSearch) {
    const params = new URLSearchParams(search);
    cachedSearch = search;
    cachedChoices = {
      active: true,
      reg: pick(params, "p753_reg"),
      chip: pick(params, "p753_chip"),
      card: pick(params, "p753_card"),
      mark: pick(params, "p753_mark"),
      touched: pick(params, "p753_touched"),
      det: pick(params, "p753_det"),
    };
  }
  return cachedChoices;
}

export function setChoice<K extends ChoiceKey>(key: K, value: ChoiceValue<K>): void {
  // Through searchParams.set, never a rebuilt query: the web client's ?t= token must survive.
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState(window.history.state, "", url);
  for (const listener of choiceListeners) listener();
}

export function usePrototype753(): Prototype753 {
  return useSyncExternalStore(subscribeChoices, readChoices);
}

/* ---------------------------------------------------------------- data */

export interface ProtoVault {
  /** Local registry id (not Obsidian's). */
  id: string;
  /** Absolute folder path. The display name is its basename, never stored. */
  path: string;
  /** Vault-relative, normalized with one trailing slash. */
  homeFolder: string;
  /** 16-hex id from Obsidian's vault list, when the path matched an entry there. */
  obsidianId: string | null;
}

export type ProtoHomeKind = "repo" | "vault" | "both";
export interface ProtoHome {
  kind: ProtoHomeKind;
  /** Registry vault id for "vault" and "both"; null means the default write vault. */
  vaultId: string | null;
}

export interface ProtoData {
  vaults: ProtoVault[];
  defaultVaultId: string | null;
  /** Keyed by project path. Absent = not set. */
  knowledgeHome: Record<string, ProtoHome>;
  extraWrites: ToolItem[];
}

const STORAGE_KEY = "omp-ui:prototype-753";
const EMPTY_DATA: ProtoData = { vaults: [], defaultVaultId: null, knowledgeHome: {}, extraWrites: [] };

function loadData(): ProtoData {
  if (!PROTOTYPE_753) return EMPTY_DATA;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY_DATA;
    const parsed = JSON.parse(raw) as Partial<ProtoData>;
    return {
      vaults: parsed.vaults ?? [],
      defaultVaultId: parsed.defaultVaultId ?? null,
      knowledgeHome: parsed.knowledgeHome ?? {},
      // A reload mid-stream would strand a running card; settle it.
      extraWrites: (parsed.extraWrites ?? []).map((item) =>
        item.status === "running" ? { ...item, status: "done" as const } : item,
      ),
    };
  } catch {
    return EMPTY_DATA;
  }
}

let data: ProtoData = loadData();
const dataListeners = new Set<() => void>();

function subscribeData(listener: () => void): () => void {
  dataListeners.add(listener);
  return () => {
    dataListeners.delete(listener);
  };
}

export function getData(): ProtoData {
  return data;
}

export function updateData(fn: (prev: ProtoData) => ProtoData): void {
  data = fn(data);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Quota or privacy mode: the in-memory store still works.
  }
  for (const listener of dataListeners) listener();
}

export function usePrototypeData(): ProtoData {
  return useSyncExternalStore(subscribeData, getData);
}

export function resetPrototype(): void {
  updateData(() => EMPTY_DATA);
}

/** Display name: the folder basename (#751). */
export function vaultName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() || trimmed;
}

function normalizePath(path: string): string {
  return path.trim().replace(/[/\\]+$/, "") || "/";
}

export const DEFAULT_HOME_FOLDER = "omp-ui/";

/** Returns an error message, or null when the vault was added. */
export function addVault(path: string, obsidianId: string | null = null): string | null {
  const normalized = normalizePath(path);
  if (data.vaults.some((v) => normalizePath(v.path) === normalized)) return "Already in the registry.";
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  updateData((prev) => ({
    ...prev,
    vaults: [...prev.vaults, { id, path: normalized, homeFolder: DEFAULT_HOME_FOLDER, obsidianId }],
    // The first vault added becomes the default write vault.
    defaultVaultId: prev.defaultVaultId ?? id,
  }));
  return null;
}

export function removeVault(id: string): void {
  updateData((prev) => {
    const vaults = prev.vaults.filter((v) => v.id !== id);
    const defaultVaultId =
      prev.defaultVaultId === id ? (vaults[0]?.id ?? null) : prev.defaultVaultId;
    // A knowledge home pinned to the removed vault falls back to the default.
    const knowledgeHome = Object.fromEntries(
      Object.entries(prev.knowledgeHome).map(([project, home]) => [
        project,
        home.vaultId === id ? { ...home, vaultId: null } : home,
      ]),
    );
    return { ...prev, vaults, defaultVaultId, knowledgeHome };
  });
}

export function setDefaultVault(id: string): void {
  updateData((prev) => ({ ...prev, defaultVaultId: id }));
}

export type HomeFolderCheck = { ok: true; value: string } | { ok: false; message: string };

export const HOME_FOLDER_ERROR = "Use a folder inside the vault, like omp-ui/.";

/** Trim; non-empty; relative; no ".." segment; no dot-segment; one trailing slash. */
export function validateHomeFolder(input: string): HomeFolderCheck {
  const trimmed = input.trim();
  if (trimmed === "" || /^[/\\]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, message: HOME_FOLDER_ERROR };
  }
  const segments = trimmed.split(/[/\\]+/).filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => s === ".." || s.startsWith("."))) {
    return { ok: false, message: HOME_FOLDER_ERROR };
  }
  return { ok: true, value: `${segments.join("/")}/` };
}

/** Stores a valid value and returns null, or returns the error and keeps the last valid value. */
export function setHomeFolder(id: string, input: string): string | null {
  const check = validateHomeFolder(input);
  if (!check.ok) return check.message;
  updateData((prev) => ({
    ...prev,
    vaults: prev.vaults.map((v) => (v.id === id ? { ...v, homeFolder: check.value } : v)),
  }));
  return null;
}

/** null clears the project's choice back to "not set". */
export function setKnowledgeHome(projectPath: string, home: ProtoHome | null): void {
  updateData((prev) => {
    const knowledgeHome = { ...prev.knowledgeHome };
    if (home === null) delete knowledgeHome[projectPath];
    else knowledgeHome[projectPath] = home;
    return { ...prev, knowledgeHome };
  });
}
