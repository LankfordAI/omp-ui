import { useState, type ReactElement } from "react";
import type { ThemeSource } from "@omp-ui/core/theme";
import type { ThemeFile } from "@omp-ui/core/theme-file";
import { OFFICIAL_THEME_REPOSITORY } from "@omp-ui/core/theme-origin";
import {
  OFFICIAL_THEME_TAGS,
  REPOSITORY_IMAGE_BYTES_MAX,
  THEME_DESCRIPTION_MAX,
  THEME_SLUG,
  THEME_SLUG_CHARS_MAX,
  THEME_TAGS_MAX,
  isThemeAuthor,
  themeDetailsFile,
  themeSlug,
} from "@omp-ui/core/theme-repository-format";
import { displayMessage } from "../../backend";
import { downloadBlob } from "../../lib/artifact-parts";
import { base64ToBytes } from "../../lib/clipboard-image";
import { useT } from "../../lib/i18n";
import { Button } from "../ui";
import { FIELD } from "./rows";

const GUIDE_URL = "https://github.com/LankfordAI/omp-ui-themes/blob/main/CONTRIBUTING.md";

/**
 * Share an authored theme to the official theme repository (#1212, ADR-0097):
 * collect the details, save the theme file and the theme details file with two
 * separate clicks (one handler never starts two downloads, which browsers
 * block), and open the contribution guide. No token, no upload.
 */
export function ThemeSharePanel(props: {
  source: ThemeSource;
  /** AppearancePage's themeFileOf. */
  themeFile: (source: ThemeSource) => Promise<ThemeFile>;
  onClose: () => void;
}): ReactElement {
  const { source } = props;
  const t = useT();
  const [slug, setSlug] = useState(() => themeSlug(source.label));
  const [tags, setTags] = useState<readonly string[]>([]);
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [rights, setRights] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const slugValid = THEME_SLUG.test(slug) && slug.length <= THEME_SLUG_CHARS_MAX;
  const authorValid = author.trim() === "" || isThemeAuthor(author.trim());
  const valid =
    slugValid && authorValid && tags.length >= 1 && tags.length <= THEME_TAGS_MAX && description.trim() !== "" && rights;

  const toggleTag = (tag: string): void =>
    setTags((current) => (current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]));

  const saveTheme = async (): Promise<void> => {
    setSaveError(null);
    let file: ThemeFile;
    try {
      file = await props.themeFile(source);
    } catch (err) {
      setSaveError(t("settings.appearance.exportFailed", { message: displayMessage(err) }));
      return;
    }
    if (source.backdrop !== undefined && file.backdrop === undefined) {
      setSaveError(t("settings.appearance.shareBackdropMissing"));
      return;
    }
    if (
      file.backdrop !== undefined &&
      file.backdrop.mime !== "image/svg+xml" &&
      base64ToBytes(file.backdrop.data).length > REPOSITORY_IMAGE_BYTES_MAX
    ) {
      setSaveError(t("settings.appearance.shareBackdropTooLarge"));
      return;
    }
    downloadBlob(`${slug}.json`, "application/json", JSON.stringify(file, null, 2));
  };

  const saveDetails = (): void => {
    setSaveError(null);
    downloadBlob(
      `${slug}.details.json`,
      "application/json",
      themeDetailsFile({ tags: [...tags], description: description.trim(), author: author.trim() || null }),
    );
  };

  return (
    <div data-testid="theme-share" className="mt-4 border-t border-line-soft pt-3">
      <h3 className="text-base font-semibold text-ink">{t("settings.appearance.shareTitle", { name: source.label })}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-mid">
        {t("settings.appearance.shareIntro", { repository: OFFICIAL_THEME_REPOSITORY })}
      </p>
      <ol className="mt-2 list-decimal pl-5 text-sm leading-relaxed text-ink-mid">
        <li>{t("settings.appearance.shareSteps1")}</li>
        <li>{t("settings.appearance.shareSteps2")}</li>
        <li>{t("settings.appearance.shareSteps3")}</li>
      </ol>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-ink-mid">
          {t("settings.appearance.shareSlug")}
          <input
            type="text"
            className={FIELD}
            value={slug}
            maxLength={THEME_SLUG_CHARS_MAX}
            onChange={(event) => setSlug(event.target.value)}
          />
          {!slugValid && <span className="text-xs text-rose">{t("settings.appearance.shareSlugInvalid")}</span>}
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink-mid">
          {t("settings.appearance.shareAuthor")}
          <input type="text" className={FIELD} value={author} maxLength={39} onChange={(event) => setAuthor(event.target.value)} />
          {!authorValid && <span className="text-xs text-rose">{t("settings.appearance.shareAuthorInvalid")}</span>}
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-sm text-ink-mid">
        {t("settings.appearance.shareDescription")}
        <input
          type="text"
          className={FIELD}
          value={description}
          maxLength={THEME_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <div role="group" aria-label={t("settings.appearance.shareTags")} className="mt-3">
        <p className="text-sm text-ink-mid">{t("settings.appearance.shareTags")}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {OFFICIAL_THEME_TAGS.map((tag) => {
            const selected = tags.includes(tag);
            return (
              <Button
                key={tag}
                size="xs"
                selected={selected}
                disabled={!selected && tags.length >= THEME_TAGS_MAX}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </Button>
            );
          })}
        </div>
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm text-ink-mid">
        <input type="checkbox" className="mt-0.5" checked={rights} onChange={(event) => setRights(event.target.checked)} />
        <span>{t("settings.appearance.shareRights")}</span>
      </label>

      {saveError !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {saveError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t("settings.appearance.shareClose")}
        </Button>
        <Button variant="ghost" onClick={() => window.open(GUIDE_URL, "_blank", "noopener,noreferrer")}>
          {t("settings.appearance.shareOpenGuide")}
        </Button>
        <Button disabled={!valid} onClick={saveDetails}>
          {t("settings.appearance.shareSaveDetails")}
        </Button>
        <Button variant="solid" disabled={!valid} onClick={() => void saveTheme()}>
          {t("settings.appearance.shareSaveTheme")}
        </Button>
      </div>
    </div>
  );
}
