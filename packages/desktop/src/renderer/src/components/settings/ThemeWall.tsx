import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  STORED_THEMES_MAX,
  deriveTheme,
  storedThemeKind,
  themeGateFailures,
  type ThemeGateFailure,
  type ThemeSource,
} from "@omp-ui/core/theme";
import type { ThemeBackdropKind } from "@omp-ui/core/theme-backdrop";
import { sourceFromDraft, type SaveStoredThemeResult } from "@omp-ui/core/theme-file";
import { OFFICIAL_THEME_REPOSITORY } from "@omp-ui/core/theme-origin";
import {
  EMPTY_THEME_META,
  effectiveThemeRepositories,
  parseThemeRepositoryRef,
  type ThemeMeta,
  type ThemeRepositoryEntry,
  type ThemeRepositoryListing,
} from "@omp-ui/core/theme-repository-format";
import { displayMessage } from "../../backend";
import type { BackdropAsset } from "../../lib/backdrop";
import { cn } from "../../lib/cn";
import { resolveTheme, storedThemes, THEMES, type Theme } from "../../lib/themes";
import { useDismissal } from "../../lib/use-dismissal";
import { useRepositoryBackdrops } from "../../lib/use-repository-backdrops";
import { useStore } from "../../store";
import { Button, Chevron, ChoiceCapsule, Chip, Empty, Panel, Switch } from "../ui";
import { FIELD, Row } from "./rows";
import { GateFailures } from "./ThemeEditor";
import { ThemePreviewOverlay } from "./ThemePreviewOverlay";
import { ThemeSpecimen } from "./ThemeSpecimen";

type Listing =
  | { status: "loading" }
  | { status: "ok"; listing: ThemeRepositoryListing }
  | { status: "error"; message: string };

/** Encoded as the Show <select> value. */
type Show = "all" | "builtin" | "yours" | "manage" | `repo:${string}`;
type Scheme = "any" | "dark" | "light";
type BackdropFilter = "any" | "none" | "image" | "scene";
type Sort = "default" | "newest" | "name";
type RepoState = "installed" | "update" | "install" | "fails";
type Slot = "fixed" | "light" | "dark";

interface WallCard {
  /** Theme id for a local card; `repo:${entry.path}` for a listing entry. */
  key: string;
  /** What the specimen paints: the stored/curated Theme, or one derived from index seeds. */
  theme: Theme;
  label: string;
  /** The id a click applies; null when the card cannot be used (not installed, or fails the gate). */
  applyId: string | null;
  /** The stored source behind the card (Edit / Duplicate / Export / Animate / Remove). */
  source: ThemeSource | null;
  /** Tags, author, description and date a repository lists (#1210). */
  meta: ThemeMeta;
  entry: ThemeRepositoryEntry | null;
  repoState: RepoState | null;
  failures: ThemeGateFailure[];
  backdropKind: ThemeBackdropKind | null;
}

const NO_REPOSITORIES: readonly string[] = [];
/** Cards per page; Show more reveals the next page (#1211). */
const PAGE = 24;
/** Placeholder hash for a previewed repository backdrop: the specimen reads the passed asset, not the hash. */
const PREVIEW_HASH = "0".repeat(64);

const MENU_ROW =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none disabled:pointer-events-none disabled:text-ink-faint";

function localCard(theme: Theme, source: ThemeSource | null): WallCard {
  return {
    key: theme.id,
    theme,
    label: theme.label,
    applyId: theme.id,
    source,
    meta: EMPTY_THEME_META,
    entry: null,
    repoState: null,
    failures: [],
    backdropKind: theme.backdrop?.kind ?? null,
  };
}

/**
 * An entry's derived theme and gate verdict, cached on the entry object: entries
 * keep their identity for a listing's life, while `sources` changes on every
 * state broadcast (#1211).
 */
const entryDrafts = new WeakMap<ThemeRepositoryEntry, { theme: Theme; failures: ThemeGateFailure[] }>();
function entryDraft(entry: ThemeRepositoryEntry): { theme: Theme; failures: ThemeGateFailure[] } {
  let hit = entryDrafts.get(entry);
  if (hit === undefined) {
    const draft = sourceFromDraft("custom-preview", entry.label, entry.seeds);
    hit = { theme: deriveTheme(draft), failures: themeGateFailures(draft) };
    entryDrafts.set(entry, hit);
  }
  return hit;
}

function repoCard(
  entry: ThemeRepositoryEntry,
  repository: string,
  sources: readonly ThemeSource[],
  storedById: ReadonlyMap<string, Theme>,
): WallCard {
  const installed =
    sources.find((s) => s.origin?.repository === repository && s.origin.path === entry.path) ?? null;
  const installedTheme = installed !== null ? (storedById.get(installed.id) ?? null) : null;
  const drafted = installedTheme === null ? entryDraft(entry) : null;
  const failures = drafted?.failures ?? [];
  const repoState: RepoState =
    installedTheme !== null
      ? installed!.origin!.blob === entry.blob
        ? "installed"
        : "update"
      : failures.length > 0
        ? "fails"
        : "install";
  return {
    key: `repo:${entry.path}`,
    theme: installedTheme ?? drafted!.theme,
    label: entry.label,
    applyId: installedTheme?.id ?? null,
    source: installedTheme !== null ? installed : null,
    meta: entry.meta,
    entry,
    repoState,
    failures,
    backdropKind: entry.backdrop,
  };
}

/**
 * A stored theme may reuse a curated theme's label (VS Code's own Dark
 * Modern), so its accessible name and chip say which kind it is.
 */
function kindLabel(theme: Theme): string | null {
  if (theme.origin !== null) return `from ${theme.origin.repository}`;
  const kind = storedThemeKind(theme.id);
  if (kind === "imported") return "imported";
  if (kind === "authored") return "custom";
  return null;
}

/**
 * Theme repository management (#1178, ADR-0096): add a public GitHub
 * repository, browse or remove the added ones. Adding fetches nothing until
 * the repository is browsed. The omp-ui themes switch (#1209, ADR-0097) lists
 * or hides the implicit official repository entry.
 */
function RepositoryManager({ onBrowse }: { onBrowse: (repository: string) => void }) {
  const repositories = useStore((s) => s.state?.themeRepositories) ?? NO_REPOSITORIES;
  const officialThemes = useStore((s) => s.state?.officialThemes) ?? true;
  const setOfficialThemes = useStore((s) => s.setOfficialThemes);
  const addThemeRepository = useStore((s) => s.addThemeRepository);
  const removeThemeRepository = useStore((s) => s.removeThemeRepository);
  // The official row stays in place while the switch is off (dimmed, Browse disabled), so toggling never moves the list.
  const showOfficial = !repositories.includes(OFFICIAL_THEME_REPOSITORY);
  const [input, setInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    setAddError(null);
    if (parseThemeRepositoryRef(input) === null) {
      setAddError("Enter a GitHub repository as owner/repo or its https://github.com address.");
      return;
    }
    try {
      const result = await addThemeRepository(input);
      if (!result.ok) {
        setAddError(`Could not add: ${result.message}`);
        return;
      }
      setInput("");
      onBrowse(result.repository);
    } catch (err) {
      setAddError(`Could not add: ${displayMessage(err)}`);
    }
  };

  return (
    <div className="mt-3">
      <Row
        title="omp-ui themes"
        hint={`Lists the official theme repository, ${OFFICIAL_THEME_REPOSITORY}, under Show so you can browse and install its themes. Nothing is downloaded until you pick it. Turning this off hides it; themes you installed stay.`}
      >
        <Switch
          on={officialThemes}
          onChange={(next) => void setOfficialThemes(next)}
          label="omp-ui themes"
        />
      </Row>
      <h3 className="text-base font-semibold text-ink">Theme repositories</h3>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">Browse themes other people publish in public GitHub repositories. Every theme must pass the same contrast checks before it is saved, installed scenes and videos start still until you allow motion, and an installed theme never changes until you update it. omp-ui contacts GitHub only when you browse or install.</p>
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-ink-mid">
          GitHub repository
          <input
            type="text"
            className={FIELD}
            value={input}
            maxLength={200}
            placeholder="owner/repo or https://github.com/owner/repo"
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <Button type="submit">Add</Button>
      </form>
      {addError !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {addError}
        </p>
      )}
      {(showOfficial || repositories.length > 0) && (
        <ul className="mt-3 flex flex-col gap-2">
          {showOfficial && (
            <li
              className={cn("flex items-center gap-2 text-sm", officialThemes ? "text-ink-mid" : "text-ink-faint")}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{OFFICIAL_THEME_REPOSITORY}</span>
              <Chip>official</Chip>
              <Button
                variant="ghost"
                disabled={!officialThemes}
                aria-label={`Browse ${OFFICIAL_THEME_REPOSITORY}`}
                onClick={() => onBrowse(OFFICIAL_THEME_REPOSITORY)}
              >
                Browse
              </Button>
            </li>
          )}
          {repositories.map((repository) => (
            <li key={repository} className="flex items-center gap-2 text-sm text-ink-mid">
              <span className="min-w-0 flex-1 truncate font-mono">{repository}</span>
              <Button
                variant="ghost"
                aria-label={`Browse ${repository}`}
                onClick={() => onBrowse(repository)}
              >
                Browse
              </Button>
              <Button
                variant="ghost"
                aria-label={`Remove repository ${repository}`}
                onClick={() => void removeThemeRepository(repository)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The theme wall (CONTEXT.md): one column of theme cards, each a live sample
 * of the app in that theme. Clicking a usable card applies it; Preview opens
 * the full-screen theme preview without applying anything. Nothing fetches
 * unless a repository is picked under Show or refreshed (ADR-0096 §6), and
 * installing never applies a theme.
 */
export function ThemeWall(props: {
  sources: readonly ThemeSource[];
  /** Resolved ids (resolveTheme(...).id). */
  pick: { themeId: string; lightThemeId: string; darkThemeId: string };
  /** The effective theme now. */
  showing: Theme;
  /** An import in flight: disables the New menu's items. */
  busy: boolean;
  /** ThemesTab's import verdicts. */
  verdict: ReactNode;
  onNewTheme: () => void;
  onImportFile: () => void;
  onImportVsCode: () => void;
  onEdit: (source: ThemeSource) => void;
  onDuplicate: (source: ThemeSource) => void;
  onExport: (source: ThemeSource) => void;
  /** Opens the Share panel for an authored theme (#1212). */
  onShare: (source: ThemeSource) => void;
}): ReactElement {
  const { sources, pick } = props;
  const themeMode = useStore((s) => s.state?.themeMode) ?? "fixed";
  const themeRepositories = useStore((s) => s.state?.themeRepositories) ?? NO_REPOSITORIES;
  const officialThemes = useStore((s) => s.state?.officialThemes) ?? true;
  // Added repositories plus the official one while it is on (#1209).
  const repositories = useMemo(
    () => effectiveThemeRepositories(themeRepositories, officialThemes),
    [themeRepositories, officialThemes],
  );
  const setThemeMode = useStore((s) => s.setThemeMode);
  const setThemeId = useStore((s) => s.setThemeId);
  const setLightThemeId = useStore((s) => s.setLightThemeId);
  const setDarkThemeId = useStore((s) => s.setDarkThemeId);
  const browseThemeRepository = useStore((s) => s.browseThemeRepository);
  const installRepositoryTheme = useStore((s) => s.installRepositoryTheme);
  const setStoredThemeMotion = useStore((s) => s.setStoredThemeMotion);
  const removeStoredTheme = useStore((s) => s.removeStoredTheme);
  const previewRepositoryThemeBackdrop = useStore((s) => s.previewRepositoryThemeBackdrop);
  const repoBackdrops = useRepositoryBackdrops(previewRepositoryThemeBackdrop);

  const [show, setShow] = useState<Show>("all");
  const [scheme, setScheme] = useState<Scheme>("any");
  const [backdropFilter, setBackdropFilter] = useState<BackdropFilter>("any");
  const [tags, setTags] = useState<readonly string[]>([]);
  const [sort, setSort] = useState<Sort>("default");
  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  // The repository whose listing is wanted; a late answer for another is dropped.
  const listingFor = useRef<string | null>(null);
  // The install in flight, by path.
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [installVerdict, setInstallVerdict] = useState<SaveStoredThemeResult | null>(null);
  const expandedRow = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLDivElement>(null);

  const closeMenu = (): void => setMenuOpen(false);
  useDismissal({ open: menuOpen, refs: [menuRef, menuButtonRef], onClose: closeMenu, onEscape: closeMenu });

  const openRepository = async (repository: string, refresh: boolean): Promise<void> => {
    listingFor.current = repository;
    setListing({ status: "loading" });
    setInstallVerdict(null);
    let next: Listing;
    try {
      const result = await browseThemeRepository(repository, refresh);
      next = result.ok ? { status: "ok", listing: result.listing } : { status: "error", message: result.message };
    } catch (err) {
      next = { status: "error", message: displayMessage(err) };
    }
    // A late answer for a repository no longer shown is dropped.
    if (listingFor.current === repository) setListing(next);
  };

  const changeShow = (next: Show): void => {
    setShow(next);
    setExpanded(null);
    // Another catalogue has other tags.
    setTags([]);
    if (next.startsWith("repo:")) {
      void openRepository(next.slice(5), false);
    } else {
      listingFor.current = null;
      setListing(null);
      setInstallVerdict(null);
    }
  };

  // A shown repository that was removed falls back to All local. Only a
  // removal counts: a just-added repository may be shown before the state
  // broadcast that lists it arrives.
  const previousRepositories = useRef(repositories);
  useEffect(() => {
    const before = previousRepositories.current;
    previousRepositories.current = repositories;
    if (!show.startsWith("repo:")) return;
    const repository = show.slice(5);
    if (before.includes(repository) && !repositories.includes(repository)) changeShow("all");
  }, [repositories, show]);

  useEffect(() => {
    expandedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);

  const stored = useMemo(() => storedThemes(sources), [sources]);
  const storedById = useMemo(() => new Map(stored.map((theme) => [theme.id, theme])), [stored]);
  const curatedCards = useMemo(() => THEMES.map((theme) => localCard(theme, null)), []);
  const storedCards = stored.map((theme) => localCard(theme, sources.find((s) => s.id === theme.id) ?? null));
  const listingCards = useMemo(
    () =>
      listing?.status === "ok"
        ? listing.listing.themes.map((entry) => repoCard(entry, listing.listing.repository, sources, storedById))
        : [],
    [listing, sources, storedById],
  );

  const previewCard =
    [...curatedCards, ...storedCards, ...listingCards].find((card) => card.key === previewKey) ?? null;
  useEffect(() => {
    // The previewed theme was removed, or the listing changed under it.
    if (previewKey !== null && previewCard === null) setPreviewKey(null);
  }, [previewKey, previewCard]);

  const apply = (id: string, slot: Slot): void => {
    if (slot === "fixed") void setThemeId(id);
    else if (slot === "light") void setLightThemeId(id);
    else void setDarkThemeId(id);
  };
  /** The slot a plain card click writes: the fixed pick, or the pick matching the theme's own scheme. */
  const clickSlot = (card: WallCard): Slot => (themeMode === "fixed" ? "fixed" : card.theme.dark ? "dark" : "light");
  const holds = (id: string, slot: Slot): boolean =>
    slot === "fixed" ? pick.themeId === id : slot === "light" ? pick.lightThemeId === id : pick.darkThemeId === id;

  const choose = (card: WallCard): void => {
    const slot = clickSlot(card);
    if (card.applyId !== null && !holds(card.applyId, slot)) {
      apply(card.applyId, slot);
      setExpanded(card.key);
      return;
    }
    // Already the pick, not installed, or failing: toggle its action row only.
    setExpanded((current) => (current === card.key ? null : card.key));
  };

  const install = async (card: WallCard): Promise<void> => {
    if (listing?.status !== "ok" || card.entry === null) return;
    const path = card.entry.path;
    setBusyPath(path);
    setInstallVerdict(null);
    try {
      setInstallVerdict(
        await installRepositoryTheme({ repository: listing.listing.repository, commit: listing.listing.commit, path }),
      );
    } catch (err) {
      setInstallVerdict({ ok: false, reason: "invalid", message: displayMessage(err) });
    } finally {
      setBusyPath(null);
    }
  };

  /** Opens the theme preview; an uninstalled entry with a backdrop fetches it once (ADR-0096 §12). */
  const openPreview = (card: WallCard): void => {
    setPreviewKey(card.key);
    if (listing?.status !== "ok" || card.entry === null || card.applyId !== null || card.entry.backdrop === null) return;
    repoBackdrops.request(
      { repository: listing.listing.repository, commit: listing.listing.commit, path: card.entry.path },
      card.entry.blob,
    );
  };

  /** What a specimen paints: an uninstalled entry gains its previewed backdrop once loaded. */
  const specimenOf = (card: WallCard): { theme: Theme; asset?: BackdropAsset | null } => {
    if (card.entry === null || card.applyId !== null) return { theme: card.theme };
    const loaded = repoBackdrops.get(card.entry.blob);
    if (loaded?.status !== "ready") return { theme: card.theme, asset: null };
    return {
      theme: {
        ...card.theme,
        backdrop: { assetHash: PREVIEW_HASH, kind: loaded.asset.kind, mime: loaded.mime, blur: loaded.blur },
      },
      asset: loaded.asset,
    };
  };

  const installButton = (card: WallCard, variant?: "solid"): ReactNode => (
    <Button
      variant={variant}
      disabled={busyPath !== null}
      aria-label={`Install theme ${card.label}`}
      onClick={() => void install(card)}
    >
      Install
    </Button>
  );
  const updateButton = (card: WallCard, variant?: "solid"): ReactNode => (
    <Button
      variant={variant}
      disabled={busyPath !== null}
      aria-label={`Update theme ${card.label}`}
      onClick={() => void install(card)}
    >
      Update
    </Button>
  );

  /** A listing card's install status, always visible below it. */
  const repoStatus = (card: WallCard): ReactNode => {
    switch (card.repoState) {
      case "installed":
        return <Chip>installed</Chip>;
      case "update":
        return updateButton(card);
      case "fails":
        return (
          <span className="text-sm text-rose">
            {`Fails ${String(card.failures.length)} colour checks; cannot be installed.`}
          </span>
        );
      default:
        if (sources.length >= STORED_THEMES_MAX) {
          return (
            <>
              <Button disabled aria-label={`Install theme ${card.label}`}>
                Install
              </Button>
              <span className="text-sm text-ink-faint">Your themes are full (24 at most); remove one to install another.</span>
            </>
          );
        }
        return installButton(card);
    }
  };

  /** An opened card's controls; empty when the card has none. */
  const actionRow = (card: WallCard): ReactNode[] => {
    const row: ReactNode[] = [];
    const id = card.applyId;
    if (themeMode === "system" && id !== null) {
      row.push(
        <Button
          key="light"
          size="xs"
          disabled={holds(id, "light")}
          aria-label={`Use ${card.label} for light`}
          onClick={() => apply(id, "light")}
        >
          Use for light
        </Button>,
        <Button
          key="dark"
          size="xs"
          disabled={holds(id, "dark")}
          aria-label={`Use ${card.label} for dark`}
          onClick={() => apply(id, "dark")}
        >
          Use for dark
        </Button>,
      );
    }
    const source = card.source;
    if (source !== null) {
      // Duplicate, Edit and Export read the stored source, never the derived Theme.
      const authored = storedThemeKind(source.id) === "authored";
      if (authored) {
        row.push(
          <Button
            key="edit"
            variant="ghost"
            aria-label={`Edit theme ${source.label}`}
            onClick={() => props.onEdit(source)}
          >
            Edit
          </Button>,
        );
      }
      row.push(
        <Button
          key="duplicate"
          variant="ghost"
          aria-label={`Duplicate theme ${source.label}`}
          onClick={() => props.onDuplicate(source)}
        >
          Duplicate
        </Button>,
      );
      if (authored) {
        row.push(
          <Button
            key="export"
            variant="ghost"
            aria-label={`Export theme ${source.label}`}
            onClick={() => props.onExport(source)}
          >
            Export
          </Button>,
        );
      }
      // A theme installed from a repository is someone else's to share (#1212).
      if (authored && source.origin === undefined) {
        row.push(
          <Button
            key="share"
            variant="ghost"
            aria-label={`Share theme ${source.label}`}
            onClick={() => props.onShare(source)}
          >
            Share…
          </Button>,
        );
      }
      if (source.origin !== undefined && (source.backdrop?.kind === "scene" || source.backdrop?.kind === "video")) {
        const origin = source.origin;
        row.push(
          <Switch
            key="animate"
            on={origin.animate}
            onChange={(next) => void setStoredThemeMotion(source.id, next)}
            label={`Animate the backdrop of ${source.label}`}
          />,
        );
      }
      row.push(
        <Button
          key="remove"
          variant="ghost"
          aria-label={`Remove theme ${source.label}`}
          onClick={() => void removeStoredTheme(source.id)}
        >
          Remove
        </Button>,
      );
    }
    return row;
  };

  const schemeChip = (card: WallCard): ReactNode => (
    <Chip>{card.theme.dark ? "dark" : "light"}</Chip>
  );
  // Listing cards carry no kind: the group heading names the repository, and
  // an uninstalled entry's placeholder id would read as "custom".
  const cardKind = (card: WallCard): string | null => (card.entry !== null ? null : kindLabel(card.theme));

  const pickChips = (card: WallCard): ReactNode[] => {
    const id = card.applyId;
    if (id === null) return [];
    const chip = (key: string, text: string) => (
      <Chip key={key} className="border-line-strong text-ink">
        {text}
      </Chip>
    );
    if (themeMode === "fixed") return holds(id, "fixed") ? [chip("fixed", "in use")] : [];
    const chips: ReactNode[] = [];
    if (holds(id, "light")) chips.push(chip("light", "light pick"));
    if (holds(id, "dark")) chips.push(chip("dark", "dark pick"));
    return chips;
  };

  const renderCard = (card: WallCard): ReactNode => {
    const kind = cardKind(card);
    const accessibleName = kind !== null ? `${card.label} (${kind})` : card.label;
    const picks = pickChips(card);
    const pressed = picks.length > 0;
    const row = expanded === card.key ? actionRow(card) : [];
    return (
      <div
        key={card.key}
        data-theme-card={card.key}
        data-testid={card.entry !== null ? "theme-repository-entry" : "theme-card"}
        className="relative"
      >
        <button
          type="button"
          aria-pressed={pressed}
          aria-label={`${accessibleName} theme`}
          onClick={() => choose(card)}
          className={cn(
            "block w-full rounded-lg border p-2 text-left transition-colors duration-150",
            pressed ? "border-line-strong bg-hover" : "border-line bg-raised hover:border-line-strong",
          )}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 pr-24">
            <span className="truncate text-sm font-medium text-ink">{card.label}</span>
            {schemeChip(card)}
            {kind !== null && <Chip>{kind}</Chip>}
            {card.backdropKind !== null && (
              <Chip>
                {card.backdropKind === "video"
                  ? "video backdrop"
                  : card.backdropKind === "scene"
                    ? "animated backdrop"
                    : "backdrop"}
              </Chip>
            )}
            {card.meta.tags.map((tag) => (
              <Chip key={`tag:${tag}`} mono>
                {tag}
              </Chip>
            ))}
            {card.repoState === "install" && <Chip>not installed</Chip>}
            {card.repoState === "update" && <Chip>update available</Chip>}
            {card.repoState === "fails" && (
              <Chip tone="rose">
                {`Fails ${String(card.failures.length)} colour checks; cannot be installed.`}
              </Chip>
            )}
            {picks}
          </span>
          {(card.meta.description !== null || card.meta.author !== null) && (
            <span className="mt-1 block truncate text-xs text-ink-faint">
              {[
                card.meta.description,
                card.meta.author !== null ? `by ${card.meta.author}` : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          )}
          <ThemeSpecimen {...specimenOf(card)} variant="card" className="mt-2" />
        </button>
        <Button
          size="xs"
          className="absolute right-2 top-2"
          aria-label={`Preview theme ${card.label}`}
          onClick={() => openPreview(card)}
        >
          Preview
        </Button>
        {card.entry !== null && <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1">{repoStatus(card)}</div>}
        {row.length > 0 && (
          <div ref={expandedRow} className="mt-1.5 flex flex-wrap items-center gap-2 px-1">
            {row}
          </div>
        )}
      </div>
    );
  };

  const previewActions = (card: WallCard): ReactNode => {
    if (card.repoState === "fails") return null;
    if (card.repoState === "install") return installButton(card, "solid");
    const id = card.applyId;
    if (id === null) return null;
    const use = (slot: Slot): void => {
      apply(id, slot);
      setPreviewKey(null);
    };
    return (
      <>
        {card.repoState === "update" && updateButton(card)}
        {themeMode === "fixed" ? (
          <Button variant="solid" disabled={holds(id, "fixed")} onClick={() => use("fixed")}>
            {holds(id, "fixed") ? "In use" : "Use this theme"}
          </Button>
        ) : (
          <>
            <Button
              variant="solid"
              disabled={holds(id, "light")}
              aria-label={`Use ${card.label} for light`}
              onClick={() => use("light")}
            >
              Use for light
            </Button>
            <Button
              variant="solid"
              disabled={holds(id, "dark")}
              aria-label={`Use ${card.label} for dark`}
              onClick={() => use("dark")}
            >
              Use for dark
            </Button>
          </>
        )}
      </>
    );
  };

  const previewNotes = (card: WallCard): string[] => {
    const notes: string[] = [];
    const loaded = card.entry !== null && card.applyId === null ? repoBackdrops.get(card.entry.blob) : undefined;
    if (loaded?.status === "loading") notes.push("Downloading the backdrop…");
    if (loaded?.status === "error") notes.push(`The backdrop could not be shown: ${loaded.message}`);
    if (specimenOf(card).theme.backdrop !== null) notes.push("The backdrop shows as a still frame here.");
    return notes;
  };

  // Groups by Show, each filtered by scheme, backdrop, tags and search, sorted, then paged.
  const shownRepository = show.startsWith("repo:") ? show.slice(5) : null;
  const builtInGroup = { title: "Built-in", cards: curatedCards };
  const yoursGroup = { title: "Your themes", cards: storedCards };
  const groups: { title: string; cards: WallCard[] }[] =
    show === "all"
      ? [builtInGroup, yoursGroup]
      : show === "builtin"
        ? [builtInGroup]
        : show === "yours"
          ? [yoursGroup]
          : shownRepository !== null
            ? [{ title: shownRepository, cards: listingCards }]
            : [];

  // Tags available in the current groups, most used first; only these can filter.
  const tagCounts = new Map<string, number>();
  for (const group of groups) {
    for (const card of group.cards) for (const tag of card.meta.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const availableTags = [...tagCounts].sort(([a, ca], [b, cb]) => cb - ca || a.localeCompare(b)).map(([tag]) => tag);
  const activeTags = tags.filter((tag) => tagCounts.has(tag));
  const activeTagsKey = activeTags.join(",");
  const toggleTag = (tag: string): void =>
    setTags(activeTags.includes(tag) ? activeTags.filter((x) => x !== tag) : [...activeTags, tag]);
  const hasDates = groups.some((group) => group.cards.some((card) => card.meta.added !== null));
  const effectiveSort: Sort = sort === "newest" && !hasDates ? "default" : sort;
  useEffect(() => setLimit(PAGE), [show, scheme, backdropFilter, activeTagsKey, effectiveSort, query]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = (card: WallCard): boolean =>
    (scheme === "any" || (scheme === "dark") === card.theme.dark) &&
    (backdropFilter === "any" ||
      (backdropFilter === "none"
        ? card.backdropKind === null
        : backdropFilter === "scene"
          ? card.backdropKind === "scene" || card.backdropKind === "video"
          : card.backdropKind === backdropFilter)) &&
    (activeTags.length === 0 || card.meta.tags.some((tag) => activeTags.includes(tag))) &&
    (needle === "" ||
      [card.label, ...card.meta.tags, card.meta.author ?? "", card.meta.description ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle));
  const sorted = (cards: WallCard[]): WallCard[] => {
    if (effectiveSort === "name") {
      return [...cards].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    }
    if (effectiveSort === "newest") {
      // Stable: undated cards keep their order, last.
      return [...cards].sort((a, b) => {
        if (a.meta.added === b.meta.added) return 0;
        if (a.meta.added === null) return 1;
        if (b.meta.added === null) return -1;
        return a.meta.added < b.meta.added ? 1 : -1;
      });
    }
    return cards;
  };
  const filteredGroups = groups
    .map((group) => ({ title: group.title, cards: sorted(group.cards.filter(matches)) }))
    .filter((group) => group.cards.length > 0);
  const matchCount = filteredGroups.reduce((sum, group) => sum + group.cards.length, 0);
  let budget = limit;
  const visibleGroups = filteredGroups
    .map((group) => {
      const cards = group.cards.slice(0, Math.max(budget, 0));
      budget -= cards.length;
      return { title: group.title, cards };
    })
    .filter((group) => group.cards.length > 0);
  const remaining = matchCount - Math.min(limit, matchCount);
  // A repository listing still loading or failed is not "no match".
  const listingSettled = shownRepository === null || listing?.status === "ok";

  // The shown repository stays selectable even before the broadcast that lists it.
  const repositoryOptions =
    shownRepository !== null && !repositories.includes(shownRepository)
      ? [...repositories, shownRepository]
      : repositories;

  const labelOf = (id: string): string => resolveTheme(id, sources).label;
  const newItem = (label: string, run: () => void, autoFocus = false): ReactNode => (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      disabled={props.busy}
      className={MENU_ROW}
      onClick={() => {
        setMenuOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-4 border-b border-line-soft bg-overlay px-4 pb-2 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <ChoiceCapsule
            label="Theme mode"
            value={themeMode}
            options={[
              { value: "fixed", label: "One theme" },
              { value: "system", label: "Follow system" },
            ]}
            onChange={(mode) => void setThemeMode(mode)}
            optionClassName="tab-label px-2"
          />
          <span className="flex-1" />
          <span className="text-sm text-ink-mid">
            {themeMode === "fixed"
              ? `Using ${labelOf(pick.themeId)}`
              : `Light: ${labelOf(pick.lightThemeId)} · Dark: ${labelOf(pick.darkThemeId)}`}
          </span>
        </div>
        {themeMode === "system" && (
          <p className="mt-1 text-xs text-ink-faint">
            Uses your light theme while the OS is in light mode and your dark theme while it is in dark mode, and switches the moment the OS does.{" "}
            <span data-testid="theme-now-showing" className="text-ink-mid">
              {`Now showing: ${props.showing.label}`}
            </span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Show"
            // Fixed width: a native select sizes to its longest option, so listing a repository would reflow the
            // toolbar. 15rem fits lankfordai/omp-ui-themes; a longer added name truncates in the closed select.
            className={cn(FIELD, "w-60 shrink-0")}
            value={show}
            onChange={(event) => changeShow(event.target.value as Show)}
          >
            <option value="all">All local</option>
            <option value="builtin">Built-in</option>
            <option value="yours">
              {`Your themes (${String(sources.length)}/${String(STORED_THEMES_MAX)})`}
            </option>
            {repositoryOptions.map((repository) => (
              <option key={repository} value={`repo:${repository}`}>
                {repository}
              </option>
            ))}
            <option value="manage">Manage repositories…</option>
          </select>
          <ChoiceCapsule
            label="Scheme"
            value={scheme}
            options={[
              { value: "any", label: "Any" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={setScheme}
            optionClassName="tab-label px-2"
          />
          <ChoiceCapsule
            label="Backdrop"
            value={backdropFilter}
            options={[
              { value: "any", label: "Any backdrop" },
              { value: "none", label: "No backdrop" },
              { value: "image", label: "Image" },
              { value: "scene", label: "Animated" },
            ]}
            onChange={setBackdropFilter}
            optionClassName="tab-label px-2"
          />
          <select
            aria-label="Sort"
            className={FIELD}
            value={effectiveSort}
            onChange={(event) => setSort(event.target.value as Sort)}
          >
            <option value="default">Default order</option>
            {hasDates && <option value="newest">Newest</option>}
            <option value="name">Name</option>
          </select>
          <input
            type="search"
            aria-label="Search themes"
            placeholder="Search themes"
            className={cn(FIELD, "min-w-0 flex-1")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div ref={menuButtonRef} className="relative">
            <Button selected={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
              New
              <Chevron open={menuOpen} />
            </Button>
            {menuOpen && (
              <div ref={menuRef} role="menu" className="absolute right-0 top-full z-20 mt-1">
                <Panel className="edge-lit animate-rise w-max p-1">
                  {newItem("New theme", props.onNewTheme, true)}
                  {newItem("Import theme file…", props.onImportFile)}
                  {newItem("Import VS Code theme…", props.onImportVsCode)}
                </Panel>
              </div>
            )}
          </div>
        </div>
        {show !== "manage" && availableTags.length > 0 && (
          <div role="group" aria-label="Tags" className="mt-2 flex flex-wrap items-center gap-1.5">
            {availableTags.map((tag) => (
              <Button
                key={tag}
                size="xs"
                selected={activeTags.includes(tag)}
                aria-label={`Filter by tag ${tag}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </Button>
            ))}
            {activeTags.length > 0 && (
              <Button size="xs" variant="ghost" onClick={() => setTags([])}>
                Clear tags
              </Button>
            )}
          </div>
        )}
      </div>

      {props.verdict}
      {installVerdict?.ok === true && (
        <p role="status" className="mt-2 text-sm text-ink-mid">
          {`Installed ${installVerdict.source.label}.`}
        </p>
      )}
      {installVerdict?.ok === false && installVerdict.reason === "gate" && (
        <GateFailures label={installVerdict.label} failures={installVerdict.failures} />
      )}
      {installVerdict?.ok === false && installVerdict.reason === "invalid" && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {`Could not install: ${installVerdict.message}`}
        </p>
      )}

      {show === "manage" ? (
        <RepositoryManager onBrowse={(repository) => changeShow(`repo:${repository}`)} />
      ) : (
        <>
          {shownRepository !== null && listing?.status === "loading" && (
            <p role="status" className="mt-3 text-sm text-ink-faint">
              {`Reading ${shownRepository}…`}
            </p>
          )}
          {shownRepository !== null && listing?.status === "error" && (
            <p role="alert" className="mt-3 text-sm text-rose">
              {`Could not read ${shownRepository}: ${listing.message}`}
            </p>
          )}
          {shownRepository !== null && listing?.status === "ok" && (
            <div className="mt-3">
              <div className="flex items-center gap-2 text-sm text-ink-faint">
                <span className="min-w-0 flex-1">
                  {`${String(listing.listing.themes.length)} themes at commit ${listing.listing.commit.slice(0, 7)}`}
                </span>
                <Button variant="ghost" onClick={() => void openRepository(shownRepository, true)}>
                  Refresh
                </Button>
              </div>
              {listing.listing.skipped > 0 && (
                <p className="mt-1 text-sm text-ink-faint">
                  {`${String(listing.listing.skipped)} listed themes were skipped (missing, or larger than 6 MiB).`}
                </p>
              )}
            </div>
          )}
          {visibleGroups.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 mt-3 text-sm font-semibold text-ink">{group.title}</h3>
              <div className="flex flex-col gap-2.5">{group.cards.map(renderCard)}</div>
            </section>
          ))}
          {remaining > 0 && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => setLimit(limit + PAGE)}>
                {`Show ${String(Math.min(PAGE, remaining))} more`}
              </Button>
            </div>
          )}
          {matchCount === 0 && listingSettled && <Empty title="No themes match." />}
        </>
      )}

      {show === "all" && repositories.length > 0 && (
        <p className="mt-3 text-sm text-ink-faint">Pick a repository under Show to see more themes; that reads it from GitHub.</p>
      )}
      <p className="mt-3 text-sm text-ink-faint">In every theme, green marks only agent activity — never decoration.</p>

      {previewCard !== null && (
        <ThemePreviewOverlay
          {...specimenOf(previewCard)}
          title={`Preview: ${previewCard.label}`}
          chips={
            <>
              {schemeChip(previewCard)}
              {cardKind(previewCard) !== null && <Chip>{cardKind(previewCard)}</Chip>}
            </>
          }
          notes={previewNotes(previewCard)}
          failures={previewCard.failures}
          actions={previewActions(previewCard)}
          onClose={() => setPreviewKey(null)}
        />
      )}
    </div>
  );
}
