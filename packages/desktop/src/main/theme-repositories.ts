import {
  THEME_REPOSITORIES_MAX,
  defaultThemeRepositoryFetch,
  fetchRepositoryThemeFile,
  fetchThemeRepositoryListing,
  parseThemeFile,
  parseThemeRepositoryRef,
  repositoryThemeMismatch,
  type Registry,
  type RepositoryThemeInstallRequest,
  type SaveStoredThemeResult,
  type ThemeRepositoryAddResult,
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

  /** Canonical id when `input` names a listed repository; null otherwise. */
  #listed(input: string): string | null {
    const repository = parseThemeRepositoryRef(input);
    if (repository === null) return null;
    return this.deps.registry.getSetting("themeRepositories").includes(repository) ? repository : null;
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
    const list = this.deps.registry.getSetting("themeRepositories");
    if (list.includes(repository)) return { ok: true, repository };
    if (list.length >= THEME_REPOSITORIES_MAX) {
      return { ok: false, message: `at most ${THEME_REPOSITORIES_MAX} theme repositories can be added; remove one first` };
    }
    this.deps.registry.setSetting("themeRepositories", [...list, repository]);
    await this.deps.broadcast();
    return { ok: true, repository };
  }

  /** Drops a repository and its cached listings; installed themes are local copies and stay. */
  async remove(input: string): Promise<void> {
    const repository = this.#listed(input);
    if (repository === null) return;
    const list = this.deps.registry.getSetting("themeRepositories");
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

  /** Installs (or updates in place) one theme from a pinned listing, through the stored-theme gate. */
  async install(request: RepositoryThemeInstallRequest): Promise<SaveStoredThemeResult> {
    const { commit, path } = request;
    const repository = this.#listed(request.repository);
    if (repository === null) return invalid(NOT_ADDED);
    let listing = this.#pinned.get(`${repository}@${commit}`);
    if (listing === undefined) {
      const fetched = await fetchThemeRepositoryListing(repository, commit, this.#fetch, this.#now);
      if (!fetched.ok) return invalid(fetched.message);
      listing = fetched.listing;
      this.#pin(listing);
    }
    const entry = listing.themes.find((t) => t.path === path);
    if (entry === undefined) return invalid("that theme is not in the repository's index");
    const file = await fetchRepositoryThemeFile(repository, commit, entry, this.#fetch, this.#now);
    if (!file.ok) return invalid(file.message);
    const parsed = parseThemeFile(file.text);
    if (!parsed.ok) return invalid(parsed.message);
    if (repositoryThemeMismatch(entry, parsed.draft)) {
      return invalid("the theme file does not match the repository's index (label, colours or backdrop differ)");
    }
    return installStoredTheme(this.deps.themes, parsed.draft, {
      repository,
      path,
      commit,
      blob: entry.blob,
      animate: false,
    });
  }
}
