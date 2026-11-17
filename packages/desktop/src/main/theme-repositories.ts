import {
  THEME_REPOSITORIES_MAX,
  checkBackdropBytes,
  defaultThemeRepositoryFetch,
  effectiveThemeRepositories,
  fetchRepositoryThemeFile,
  fetchThemeRepositoryListing,
  parseThemeFile,
  parseThemeRepositoryRef,
  repositoryThemeMismatch,
  type Registry,
  type RepositoryThemeBackdropResult,
  type RepositoryThemeInstallRequest,
  type SaveStoredThemeResult,
  type StoredThemeDraft,
  type ThemeRepositoryAddResult,
  type ThemeRepositoryEntry,
  type ThemeRepositoryFetch,
  type ThemeRepositoryListing,
  type ThemeRepositoryListingResult,
} from "@omp-ui/core";
import { installStoredTheme, type StoredThemeDeps } from "./stored-themes";

const LISTING_TTL_MS = 5 * 60_000;
const PINNED_MAX = 32;
const NOT_ADDED = "add the repository first";

export interface ThemeRepositoryDeps {
  registry: Registry;
  broadcast: () => Promise<void>;
  themes: StoredThemeDeps;
  fetch?: ThemeRepositoryFetch;
  now?: () => number;
}

interface HeadEntry {
  at: number;
  pending: boolean;
  result: Promise<ThemeRepositoryListingResult>;
}

const invalid = (message: string): SaveStoredThemeResult => ({ ok: false, reason: "invalid", message });

/** Theme repositories (#1178, ADR-0096): the list, cached listings, and the install route. */
export class ThemeRepositoryService {
  // repository → newest HEAD listing; pending entries are shared by concurrent callers.
  readonly #head = new Map<string, HeadEntry>();
  // `${repository}@${commit}` → successful listing, oldest evicted past PINNED_MAX.
  readonly #pinned = new Map<string, ThemeRepositoryListing>();
  readonly #fetch: ThemeRepositoryFetch;
  readonly #now: () => number;

  constructor(private readonly deps: ThemeRepositoryDeps) {
    this.#fetch = deps.fetch ?? defaultThemeRepositoryFetch;
    this.#now = deps.now ?? Date.now;
  }

  /** Canonical id when `input` names a listed repository (added, or the official one while on); null otherwise. */
  #listed(input: string): string | null {
    const repository = parseThemeRepositoryRef(input);
    if (repository === null) return null;
    return this.#effective().includes(repository) ? repository : null;
  }

  #effective(): string[] {
    const { registry } = this.deps;
    return effectiveThemeRepositories(registry.getSetting("themeRepositories"), registry.getSetting("officialThemes"));
  }

  #pin(listing: ThemeRepositoryListing): void {
    const key = `${listing.repository}@${listing.commit}`;
    this.#pinned.delete(key);
    this.#pinned.set(key, listing);
    while (this.#pinned.size > PINNED_MAX) {
      const oldest = this.#pinned.keys().next().value;
      if (oldest === undefined) break;
      this.#pinned.delete(oldest);
    }
  }

  /** Adds a repository; never fetches. */
  async add(input: string): Promise<ThemeRepositoryAddResult> {
    const repository = parseThemeRepositoryRef(input);
    if (repository === null) {
      return { ok: false, message: "enter a GitHub repository as owner/repo or its https://github.com address" };
    }
    // Already listed, including the official repository while it is on: nothing to write.
    if (this.#effective().includes(repository)) return { ok: true, repository };
    const list = this.deps.registry.getSetting("themeRepositories");
    if (list.length >= THEME_REPOSITORIES_MAX) {
      return { ok: false, message: `at most ${THEME_REPOSITORIES_MAX} theme repositories can be added; remove one first` };
    }
    this.deps.registry.setSetting("themeRepositories", [...list, repository]);
    await this.deps.broadcast();
    return { ok: true, repository };
  }

  /** Drops a repository and its cached listings; installed themes are local copies and stay. */
  async remove(input: string): Promise<void> {
    // Only an added repository can be removed; the implicit official entry changes nothing.
    const repository = parseThemeRepositoryRef(input);
    const list = this.deps.registry.getSetting("themeRepositories");
    if (repository === null || !list.includes(repository)) return;
    this.deps.registry.setSetting(
      "themeRepositories",
      list.filter((r) => r !== repository),
    );
    this.#head.delete(repository);
    for (const key of [...this.#pinned.keys()]) {
      if (key.startsWith(`${repository}@`)) this.#pinned.delete(key);
    }
    await this.deps.broadcast();
  }

  /** The repository's themes at HEAD; a fresh or in-flight listing is reused unless `refresh`. */
  browse(input: string, refresh: boolean): Promise<ThemeRepositoryListingResult> {
    const repository = this.#listed(input);
    if (repository === null) return Promise.resolve({ ok: false, message: NOT_ADDED });
    const cached = this.#head.get(repository);
    if (cached !== undefined && (cached.pending || (!refresh && this.#now() - cached.at < LISTING_TTL_MS))) {
      return cached.result;
    }
    const result = fetchThemeRepositoryListing(repository, null, this.#fetch, this.#now);
    const entry: HeadEntry = { at: this.#now(), pending: true, result };
    this.#head.set(repository, entry);
    void result.then((settled) => {
      if (settled.ok) {
        entry.pending = false;
        entry.at = this.#now();
        this.#pin(settled.listing);
      } else if (this.#head.get(repository) === entry) {
        this.#head.delete(repository);
      }
    });
    return result;
  }

  /** The pinned listing's entry and its theme file, blob-checked, parsed and matched to the index. */
  async #verifiedDraft(
    request: RepositoryThemeInstallRequest,
  ): Promise<
    | { ok: true; repository: string; entry: ThemeRepositoryEntry; draft: StoredThemeDraft }
    | { ok: false; message: string }
  > {
    const { commit, path } = request;
    const repository = this.#listed(request.repository);
    if (repository === null) return { ok: false, message: NOT_ADDED };
    let listing = this.#pinned.get(`${repository}@${commit}`);
    if (listing === undefined) {
      const fetched = await fetchThemeRepositoryListing(repository, commit, this.#fetch, this.#now);
      if (!fetched.ok) return fetched;
      listing = fetched.listing;
      this.#pin(listing);
    }
    const entry = listing.themes.find((t) => t.path === path);
    if (entry === undefined) return { ok: false, message: "that theme is not in the repository's index" };
    const file = await fetchRepositoryThemeFile(repository, commit, entry, this.#fetch, this.#now);
    if (!file.ok) return file;
    const parsed = parseThemeFile(file.text);
    if (!parsed.ok) return parsed;
    if (repositoryThemeMismatch(entry, parsed.draft)) {
      return {
        ok: false,
        message: "the theme file does not match the repository's index (label, colours or backdrop differ)",
      };
    }
    return { ok: true, repository, entry, draft: parsed.draft };
  }

  /** Installs (or updates in place) one theme from a pinned listing, through the stored-theme gate. */
  async install(request: RepositoryThemeInstallRequest): Promise<SaveStoredThemeResult> {
    const verified = await this.#verifiedDraft(request);
    if (!verified.ok) return invalid(verified.message);
    return installStoredTheme(
      this.deps.themes,
      verified.draft,
      {
        repository: verified.repository,
        path: request.path,
        commit: request.commit,
        blob: verified.entry.blob,
        animate: false,
      },
      // Listed when the row is written, not only when the download started (#1209).
      () => this.#listed(verified.repository) !== null,
    );
  }

  /** One theme's backdrop for Preview (#1182): the same checks as install; nothing is stored. */
  async previewBackdrop(request: RepositoryThemeInstallRequest): Promise<RepositoryThemeBackdropResult> {
    const verified = await this.#verifiedDraft(request);
    if (!verified.ok) return verified;
    const backdrop = verified.draft.backdrop;
    if (backdrop === null || backdrop.from !== "bytes") return { ok: false, message: "the theme has no backdrop" };
    const check = checkBackdropBytes(Buffer.from(backdrop.data, "base64"));
    if (!check.ok) return { ok: false, message: check.message };
    return { ok: true, backdrop: { mime: check.mime, data: backdrop.data, blur: backdrop.blur } };
  }
}
