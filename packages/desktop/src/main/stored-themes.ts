import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  STORED_THEMES_MAX,
  checkBackdropBytes,
  isStoredThemeDraft,
  sourceFromDraft,
  storedThemeKind,
  themeGateFailures,
  type Registry,
  type SaveStoredThemeResult,
  type StoredThemeDraft,
  type ThemeOrigin,
  type ThemeSource,
} from "@omp-ui/core";
import type { ThemeBackdropStore } from "./theme-backdrop-store";

export interface StoredThemeDeps {
  registry: Registry;
  broadcast: () => Promise<void>;
  backdrops: ThemeBackdropStore;
  /** Mints an authored id; the backend passes (l) => authoredThemeId(l, randomUUID()). */
  newId: (label: string) => string;
}

/** Fresh ids tried before giving up; a collision needs the same 6 hex digits twice. */
const NEW_ID_ATTEMPTS = 5;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const invalid = (message: string): SaveStoredThemeResult => ({ ok: false, reason: "invalid", message });

/**
 * Every mutation of the stored themes and their assets runs one at a time per
 * backdrop store: a save writes its asset before the registry names it, so a
 * prune from a concurrent save, remove, or the startup sweep must not run in
 * between and delete it.
 */
const queues = new WeakMap<ThemeBackdropStore, Promise<unknown>>();
function serialized<T>(deps: StoredThemeDeps, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(deps.backdrops) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    deps.backdrops,
    next.catch(() => undefined),
  );
  return next;
}

function decodeBase64(data: string): Uint8Array | null {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return null;
  return new Uint8Array(Buffer.from(data, "base64"));
}

/**
 * The one host save path every authoring route ends in (issue #1168): the
 * editor, a theme file, and the agent tool. It builds the theme from seeds,
 * runs the contrast gate and the signal rule, stores the backdrop bytes, and
 * writes the registry. A remote client cannot store a theme the gate refuses.
 */
export function saveStoredTheme(
  deps: StoredThemeDeps,
  draft: StoredThemeDraft,
): Promise<SaveStoredThemeResult> {
  // The editor path never carries an origin: editing an installed theme detaches it (#1178).
  return serialized(deps, () => saveDraft(deps, draft, null));
}

/**
 * The theme repository route (#1178): same gate and backdrop checks; a
 * reinstall of the same repository path replaces in place.
 */
export function installStoredTheme(
  deps: StoredThemeDeps,
  draft: StoredThemeDraft,
  origin: ThemeOrigin,
  /** Checked when the queued save runs, so a remove or disable queued first wins (#1209). */
  stillListed: () => boolean,
): Promise<SaveStoredThemeResult> {
  return serialized(deps, () =>
    stillListed() ? saveDraft(deps, draft, origin) : Promise.resolve(invalid("add the repository first")),
  );
}

async function saveDraft(
  deps: StoredThemeDeps,
  draft: StoredThemeDraft,
  origin: ThemeOrigin | null,
): Promise<SaveStoredThemeResult> {
  if (!isStoredThemeDraft(draft)) return invalid("the theme is malformed");
  const label = draft.label.trim();
  const stored = deps.registry.getSetting("storedThemes");
  let replaceId = draft.id;
  if (origin !== null) {
    // An update keeps the installed theme's id (and so its picks) and its motion choice.
    const { repository, path } = origin;
    const installed = stored.find((t) => t.origin?.repository === repository && t.origin.path === path);
    if (installed?.origin !== undefined) {
      replaceId = installed.id;
      origin = { ...origin, animate: installed.origin.animate };
    }
  }
  let id: string;
  if (replaceId !== undefined) {
    const existing = stored.find((t) => t.id === replaceId);
    if (existing === undefined || storedThemeKind(existing.id) !== "authored") {
      return invalid("only an authored theme can be replaced");
    }
    id = replaceId;
  } else {
    let minted: string | null = null;
    for (let attempt = 0; attempt < NEW_ID_ATTEMPTS && minted === null; attempt++) {
      const candidate = deps.newId(label);
      if (!stored.some((t) => t.id === candidate)) minted = candidate;
    }
    if (minted === null) return invalid("could not allocate a theme id");
    id = minted;
  }
  const source = sourceFromDraft(id, label, draft.seeds);
  if (origin !== null) source.origin = origin;
  const failures = themeGateFailures(source);
  if (failures.length > 0) return { ok: false, reason: "gate", label, failures };
  const backdrop = draft.backdrop;
  if (backdrop !== null) {
    let bytes: Uint8Array;
    if (backdrop.from === "bytes") {
      const decoded = decodeBase64(backdrop.data);
      if (decoded === null) return invalid("the backdrop is not valid base64");
      bytes = decoded;
    } else {
      const read = await deps.backdrops.read(backdrop.assetHash);
      if (read === null) return invalid("that backdrop is no longer stored");
      bytes = read;
    }
    const check = checkBackdropBytes(bytes);
    if (!check.ok) return invalid(check.message);
    const assetHash = backdrop.from === "bytes" ? await deps.backdrops.put(bytes) : backdrop.assetHash;
    source.backdrop = { assetHash, kind: check.kind, mime: check.mime, blur: backdrop.blur };
  }
  return commitSource(deps, source);
}

/** Stores an already-built source (the VS Code import route). */
export function commitStoredTheme(
  deps: StoredThemeDeps,
  source: ThemeSource,
): Promise<SaveStoredThemeResult> {
  return serialized(deps, () => commitSource(deps, source));
}

async function commitSource(deps: StoredThemeDeps, source: ThemeSource): Promise<SaveStoredThemeResult> {
  const stored = deps.registry.getSetting("storedThemes");
  const index = stored.findIndex((t) => t.id === source.id);
  if (index === -1 && stored.length >= STORED_THEMES_MAX) {
    return invalid(`at most ${STORED_THEMES_MAX} stored themes can be kept; remove one first`);
  }
  // A replacement keeps its place in the list; a new theme appends.
  const next = index === -1 ? [...stored, source] : stored.map((t, i) => (i === index ? source : t));
  deps.registry.setSetting("storedThemes", next);
  await pruneUnreferenced(deps);
  await deps.broadcast();
  return { ok: true, source };
}

/**
 * Picks naming the removed theme fall back to their defaults, so the registry
 * never points at a theme that no longer exists.
 */
export function removeStoredTheme(deps: StoredThemeDeps, id: string): Promise<void> {
  return serialized(deps, async () => {
    const reg = deps.registry;
    // A non-stored id (curated or unknown) must change nothing at all: the
    // pick resets below are keyed by equality with it and would repaint (#1176).
    if (!reg.getSetting("storedThemes").some((t) => t.id === id)) return;
    reg.setSetting("storedThemes", reg.getSetting("storedThemes").filter((t) => t.id !== id));
    if (reg.getSetting("themeId") === id) reg.setSetting("themeId", DEFAULT_THEME_ID);
    if (reg.getSetting("darkThemeId") === id) reg.setSetting("darkThemeId", DEFAULT_THEME_ID);
    if (reg.getSetting("lightThemeId") === id) reg.setSetting("lightThemeId", DEFAULT_LIGHT_THEME_ID);
    await pruneUnreferenced(deps);
    await deps.broadcast();
  });
}

/** Lets one installed repository theme's scene animate (#1178); other rows change nothing. */
export function setStoredThemeMotion(deps: StoredThemeDeps, id: string, on: boolean): Promise<void> {
  return serialized(deps, async () => {
    const stored = deps.registry.getSetting("storedThemes");
    const row = stored.find((t) => t.id === id);
    const origin = row?.origin;
    if (origin === undefined || origin.animate === on) return;
    deps.registry.setSetting(
      "storedThemes",
      stored.map((t) => (t === row ? { ...t, origin: { ...origin, animate: on } } : t)),
    );
    await deps.broadcast();
  });
}

/**
 * Lists or hides the official theme repository (#1209). Runs in the stored-theme
 * queue, so an install of an official theme queued behind it sees the new value.
 */
export function setOfficialThemes(deps: StoredThemeDeps, on: boolean): Promise<void> {
  return serialized(deps, async () => {
    deps.registry.setSetting("officialThemes", on);
    await deps.broadcast();
  });
}

/** Deletes every backdrop asset no stored theme references. */
export function pruneThemeBackdrops(deps: StoredThemeDeps): Promise<void> {
  return serialized(deps, () => pruneUnreferenced(deps));
}

async function pruneUnreferenced(deps: StoredThemeDeps): Promise<void> {
  const keep = new Set<string>();
  for (const theme of deps.registry.getSetting("storedThemes")) {
    if (theme.backdrop !== undefined) keep.add(theme.backdrop.assetHash);
  }
  await deps.backdrops.prune(keep);
}
