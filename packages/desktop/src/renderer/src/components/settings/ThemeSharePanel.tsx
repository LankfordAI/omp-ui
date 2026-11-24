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
import { Button } from "../ui";
import { FIELD } from "./rows";

const GUIDE_URL = "https://github.com/LankfordAI/omp-ui-themes/blob/main/CONTRIBUTING.md";
const VIDEO_SHARE_ERROR = "The official repository accepts image and SVG backdrops only; video backdrops stay local.";
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
  const [slug, setSlug] = useState(() => themeSlug(source.label));
  const [tags, setTags] = useState<readonly string[]>([]);
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [rights, setRights] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasVideoBackdrop = source.backdrop?.kind === "video";
  const slugValid = THEME_SLUG.test(slug) && slug.length <= THEME_SLUG_CHARS_MAX;
  const authorValid = author.trim() === "" || isThemeAuthor(author.trim());
  const valid =
    !hasVideoBackdrop &&
    slugValid &&
    authorValid &&
    tags.length >= 1 &&
    tags.length <= THEME_TAGS_MAX &&
    description.trim() !== "" &&
    rights;
  const toggleTag = (tag: string): void =>
    setTags((current) => (current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]));

  const saveTheme = async (): Promise<void> => {
    if (hasVideoBackdrop) {
      setSaveError(VIDEO_SHARE_ERROR);
      return;
    }
    setSaveError(null);
    let file: ThemeFile;
    try {
      file = await props.themeFile(source);
    } catch (err) {
      setSaveError(`Could not export: ${displayMessage(err)}`);
      return;
    }
    if (source.backdrop !== undefined && file.backdrop === undefined) {
      setSaveError("This theme's backdrop is not available on this host, so the file would be incomplete.");
      return;
    }
    if (
      file.backdrop !== undefined &&
      file.backdrop.mime !== "image/svg+xml" &&
      base64ToBytes(file.backdrop.data).length > REPOSITORY_IMAGE_BYTES_MAX
    ) {
      setSaveError("The official repository accepts image backdrops up to 1 MiB; this one is larger.");
      return;
    }
    downloadBlob(`${slug}.json`, "application/json", JSON.stringify(file, null, 2));
  };

  const saveDetails = (): void => {
    if (hasVideoBackdrop) {
      setSaveError(VIDEO_SHARE_ERROR);
      return;
    }
    setSaveError(null);
    downloadBlob(
      `${slug}.details.json`,
      "application/json",
      themeDetailsFile({ tags: [...tags], description: description.trim(), author: author.trim() || null }),
    );
  };

  return (
    <div data-testid="theme-share" className="mt-4 border-t border-line-soft pt-3">
      <h3 className="text-base font-semibold text-ink">{`Share ${source.label}`}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-mid">
        {`Themes are shared through the official repository, ${OFFICIAL_THEME_REPOSITORY}. Fill in the details, save both files, and add them in a pull request. Shared themes are released under CC0 1.0.`}
      </p>
      <ol className="mt-2 list-decimal pl-5 text-sm leading-relaxed text-ink-mid">
        <li>Save both files.</li>
        <li>Fork the repository and add both files under themes/.</li>
        <li>Open a pull request; the checks run on their own.</li>
      </ol>

      {hasVideoBackdrop && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {VIDEO_SHARE_ERROR}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-ink-mid">
          File name
          <input
            type="text"
            className={FIELD}
            value={slug}
            maxLength={THEME_SLUG_CHARS_MAX}
            onChange={(event) => setSlug(event.target.value)}
          />
          {!slugValid && <span className="text-xs text-rose">Use lowercase letters, digits and single hyphens, 64 characters at most.</span>}
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink-mid">
          GitHub username (optional)
          <input type="text" className={FIELD} value={author} maxLength={39} onChange={(event) => setAuthor(event.target.value)} />
          {!authorValid && <span className="text-xs text-rose">That is not a GitHub username.</span>}
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-sm text-ink-mid">
        Description
        <input
          type="text"
          className={FIELD}
          value={description}
          maxLength={THEME_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <div role="group" aria-label="Tags (1 to 6)" className="mt-3">
        <p className="text-sm text-ink-mid">Tags (1 to 6)</p>
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
        <span>I made this theme and its backdrop, or have the right to release them, and I release them under CC0 1.0.</span>
      </label>

      {saveError !== null && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {saveError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          Close
        </Button>
        <Button variant="ghost" onClick={() => window.open(GUIDE_URL, "_blank", "noopener,noreferrer")}>
          Open the contribution guide
        </Button>
        <Button disabled={!valid} onClick={saveDetails}>
          Save details file
        </Button>
        <Button variant="solid" disabled={!valid} onClick={() => void saveTheme()}>
          Save theme file
        </Button>
      </div>
    </div>
  );
}
