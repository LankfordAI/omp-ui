import { useMemo, useRef, useState, type ReactNode } from "react";
import { STORED_THEMES_MAX, deriveTheme, themeGateFailures, type ThemeSource } from "@omp-ui/core/theme";
import { sourceFromDraft, type SaveStoredThemeResult } from "@omp-ui/core/theme-file";
import {
  parseThemeRepositoryRef,
  type ThemeRepositoryListing,
} from "@omp-ui/core/theme-repository-format";
import { displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { Button, Chip } from "../ui";
import { FIELD } from "./rows";
import { GateFailures, SwatchStrip } from "./ThemeEditor";

type Listing =
  | { status: "loading" }
  | { status: "ok"; listing: ThemeRepositoryListing }
  | { status: "error"; message: string };

/**
 * Theme repositories (#1178, ADR-0096): add a public GitHub repository,
 * browse the themes its index lists (previewed from seeds, no backdrop
 * download), and install or update them through the host's stored-theme
 * gate. Installing never applies a theme.
 */
export function ThemeRepositoriesSection({ sources }: { sources: readonly ThemeSource[] }) {
  const t = useT();
  const repositories = useStore((s) => s.state?.themeRepositories) ?? [];
  const addThemeRepository = useStore((s) => s.addThemeRepository);
  const removeThemeRepository = useStore((s) => s.removeThemeRepository);
  const browseThemeRepository = useStore((s) => s.browseThemeRepository);
  const installRepositoryTheme = useStore((s) => s.installRepositoryTheme);
  const [input, setInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // One repository open at a time.
  const [open, setOpen] = useState<string | null>(null);
  const openRef = useRef<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  // The install in flight, by path.
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<SaveStoredThemeResult | null>(null);

  const openRepository = async (repository: string, refresh: boolean): Promise<void> => {
    openRef.current = repository;
    setOpen(repository);
    setListing({ status: "loading" });
    setVerdict(null);
    let next: Listing;
    try {
      const result = await browseThemeRepository(repository, refresh);
      next = result.ok ? { status: "ok", listing: result.listing } : { status: "error", message: result.message };
    } catch (err) {
      next = { status: "error", message: displayMessage(err) };
    }
    // A late answer for a repository no longer open is dropped.
    if (openRef.current === repository) setListing(next);
  };

  const close = (): void => {
    openRef.current = null;
    setOpen(null);
    setListing(null);
    setVerdict(null);
  };

  const add = async (): Promise<void> => {
    setAddError(null);
    if (parseThemeRepositoryRef(input) === null) {
      setAddError(t("settings.appearance.repoInvalid"));
      return;
    }
    try {
      const result = await addThemeRepository(input);
      if (!result.ok) {
        setAddError(t("settings.appearance.repoAddFailed", { message: result.message }));
        return;
      }
      setInput("");
      await openRepository(result.repository, false);
    } catch (err) {
      setAddError(t("settings.appearance.repoAddFailed", { message: displayMessage(err) }));
    }
  };

  const remove = (repository: string): void => {
    if (openRef.current === repository) close();
    void removeThemeRepository(repository);
  };

  const install = async (repository: string, commit: string, path: string): Promise<void> => {
    setBusyPath(path);
    setVerdict(null);
    try {
      setVerdict(await installRepositoryTheme({ repository, commit, path }));
    } catch (err) {
      setVerdict({ ok: false, reason: "invalid", message: displayMessage(err) });
    } finally {
      setBusyPath(null);
    }
  };

  const cards = useMemo(() => {
    if (listing?.status !== "ok") return [];
    return listing.listing.themes.map((entry) => {
      const source = sourceFromDraft("custom-preview", entry.label, entry.seeds);
      return { entry, preview: deriveTheme(source), failures: themeGateFailures(source) };
    });
  }, [listing]);

  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <h3 className="text-base font-semibold text-ink">{t("settings.appearance.repoTitle")}</h3>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">{t("settings.appearance.repoHint")}</p>
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-ink-mid">
          {t("settings.appearance.repoInputLabel")}
          <input
            type="text"
            className={FIELD}
            value={input}
            maxLength={200}
            placeholder={t("settings.appearance.repoInputPlaceholder")}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <Button type="submit">{t("settings.appearance.repoAdd")}</Button>
      </form>
      {addError !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {addError}
        </p>
      )}
      {repositories.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {repositories.map((repository) => {
            const isOpen = open === repository;
            return (
              <li key={repository} className="text-sm text-ink-mid">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono">{repository}</span>
                  <Button
                    variant="ghost"
                    aria-label={t("settings.appearance.repoBrowseAria", { repository })}
                    onClick={() => (isOpen ? close() : void openRepository(repository, false))}
                  >
                    {isOpen ? t("settings.appearance.repoHide") : t("settings.appearance.repoBrowse")}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={t("settings.appearance.repoRemoveAria", { repository })}
                    onClick={() => remove(repository)}
                  >
                    {t("settings.appearance.remove")}
                  </Button>
                </div>
                {isOpen && listing?.status === "loading" && (
                  <p role="status" className="mt-2 text-sm text-ink-faint">
                    {t("settings.appearance.repoLoading", { repository })}
                  </p>
                )}
                {isOpen && listing?.status === "error" && (
                  <p role="alert" className="mt-2 text-sm text-rose">
                    {t("settings.appearance.repoFailed", { repository, message: listing.message })}
                  </p>
                )}
                {isOpen && listing?.status === "ok" && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2 text-sm text-ink-faint">
                      <span className="min-w-0 flex-1">
                        {t("settings.appearance.repoCommit", {
                          count: String(listing.listing.themes.length),
                          commit: listing.listing.commit.slice(0, 7),
                        })}
                      </span>
                      <Button variant="ghost" onClick={() => void openRepository(repository, true)}>
                        {t("settings.appearance.repoRefresh")}
                      </Button>
                    </div>
                    {listing.listing.skipped > 0 && (
                      <p className="mt-1 text-sm text-ink-faint">
                        {t("settings.appearance.repoSkipped", { count: String(listing.listing.skipped) })}
                      </p>
                    )}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {cards.map(({ entry, preview, failures }) => {
                        const installed = sources.find(
                          (s) => s.origin?.repository === repository && s.origin.path === entry.path,
                        );
                        const installEntry = (): void =>
                          void install(repository, listing.listing.commit, entry.path);
                        let status: ReactNode;
                        if (installed?.origin !== undefined && installed.origin.blob === entry.blob) {
                          status = <Chip>{t("settings.appearance.repoInstalledChip")}</Chip>;
                        } else if (installed !== undefined) {
                          status = (
                            <Button
                              disabled={busyPath !== null}
                              aria-label={t("settings.appearance.repoUpdateAria", { name: entry.label })}
                              onClick={installEntry}
                            >
                              {t("settings.appearance.repoUpdate")}
                            </Button>
                          );
                        } else if (failures.length > 0) {
                          status = (
                            <span className="text-sm text-rose">
                              {t("settings.appearance.repoGateFailed", { count: String(failures.length) })}
                            </span>
                          );
                        } else if (sources.length >= STORED_THEMES_MAX) {
                          status = (
                            <>
                              <Button disabled aria-label={t("settings.appearance.repoInstallAria", { name: entry.label })}>
                                {t("settings.appearance.repoInstall")}
                              </Button>
                              <span className="text-sm text-ink-faint">{t("settings.appearance.repoFull")}</span>
                            </>
                          );
                        } else {
                          status = (
                            <Button
                              disabled={busyPath !== null}
                              aria-label={t("settings.appearance.repoInstallAria", { name: entry.label })}
                              onClick={installEntry}
                            >
                              {t("settings.appearance.repoInstall")}
                            </Button>
                          );
                        }
                        return (
                          <div
                            key={entry.path}
                            data-testid="theme-repository-entry"
                            className="rounded-lg border border-line bg-raised p-3 text-left"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium text-ink">{entry.label}</span>
                              <Chip>
                                {preview.dark
                                  ? t("settings.appearance.themeDark")
                                  : t("settings.appearance.themeLight")}
                              </Chip>
                              {entry.backdrop !== null && (
                                <Chip>
                                  {entry.backdrop === "scene"
                                    ? t("settings.appearance.themeScene")
                                    : t("settings.appearance.themeBackdrop")}
                                </Chip>
                              )}
                            </span>
                            <SwatchStrip theme={preview} />
                            <div className="mt-2 flex flex-wrap items-center gap-2">{status}</div>
                          </div>
                        );
                      })}
                    </div>
                    {verdict?.ok === true && (
                      <p role="status" className="mt-2 text-sm text-ink-mid">
                        {t("settings.appearance.repoInstalled", { name: verdict.source.label })}
                      </p>
                    )}
                    {verdict?.ok === false && verdict.reason === "gate" && (
                      <GateFailures label={verdict.label} failures={verdict.failures} />
                    )}
                    {verdict?.ok === false && verdict.reason === "invalid" && (
                      <p role="alert" className="mt-2 text-sm text-rose">
                        {t("settings.appearance.repoInstallFailed", { message: verdict.message })}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
