import { useRef, useState } from "react";
import type { ProjectIconRequest, ProjectRecord } from "@omp-ui/core/types";
import { displayMessage } from "../backend";
import { bytesToBase64 } from "../lib/clipboard-image";
import { useT } from "../lib/i18n";
import { projectIconUrl, projectIdentitySeed } from "../lib/repository-members";
import { useStore } from "../store";
import { ProjectMonogram } from "./ProjectMonogram";
import { Button } from "./ui";

/** Matches core's PROJECT_ICON_MAX_SOURCE_BYTES; a bigger pick is refused before it is sent. */
const MAX_PICK_BYTES = 1024 * 1024;

const ROSE_LINE = "mt-3 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose";

/**
 * The project's icon (issue #1000): what the monogram paints in place of
 * initials. Detection reads the checkout's favicon or app icon on the owning
 * instance; a picked image is sent there as base64 and comes back shrunk on
 * the record; "Use initials" is a standing choice that detection respects.
 */
export function ProjectIconSection({ project, instanceId }: { project: ProjectRecord; instanceId: string | null }) {
  const t = useT();
  const setProjectIcon = useStore((s) => s.setProjectIcon);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Detection that finds nothing stores null, which reads the same as "never
  // looked"; this says so right after an explicit detect.
  const [notFound, setNotFound] = useState(false);

  const run = async (req: ProjectIconRequest): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotFound(false);
    try {
      const icon = await setProjectIcon(project.path, req, instanceId);
      if (req.kind === "detect" && icon === null) setNotFound(true);
    } catch (err) {
      setError(displayMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > MAX_PICK_BYTES) {
      setError(t("project.settings.iconTooLarge"));
      return;
    }
    await run({ kind: "custom", data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
  };

  const icon = project.icon ?? null;
  const status =
    icon?.source === "detected"
      ? t("project.settings.iconDetected", { file: icon.file })
      : icon?.source === "custom"
        ? t("project.settings.iconCustom")
        : icon?.source === "none"
          ? t("project.settings.iconInitials")
          : t("project.settings.iconNone");

  return (
    <section aria-labelledby="project-settings-icon" className="px-4 py-4">
      <h3 id="project-settings-icon" className="mb-1 font-display text-sm font-semibold text-ink">
        {t("project.settings.icon")}
      </h3>
      <p className="text-[11px] leading-relaxed text-ink-faint">{t("project.settings.iconHint")}</p>

      <div className="mt-3 flex items-center gap-3">
        <ProjectMonogram
          seed={projectIdentitySeed({ repositoryKey: project.repositoryKey, instanceId, projectCwd: project.path })}
          name={project.name}
          icon={projectIconUrl(icon)}
          className="size-10 rounded-lg text-sm"
        />
        <p data-testid="project-icon-status" className="min-w-0 text-xs text-ink-mid">
          {notFound ? t("project.settings.iconNotFound") : status}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => picker.current?.click()}>
          {t("project.settings.iconChoose")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run({ kind: "detect" })}>
          {t("project.settings.iconDetect")}
        </Button>
        <Button variant="ghost" disabled={busy || icon?.source === "none"} onClick={() => void run({ kind: "none" })}>
          {t("project.settings.iconUseInitials")}
        </Button>
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp,image/x-icon,.ico,.svg"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        onChange={(event) => void pick(event)}
      />

      {error !== null && <p role="alert" className={ROSE_LINE}>{error}</p>}
    </section>
  );
}
