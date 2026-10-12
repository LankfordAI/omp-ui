import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { CONTEXT_FILES_EXTRA_KEY } from "@omp-ui/core/omp-settings-keys";
import { useT } from "../../lib/i18n";
import { Button, Label } from "../ui";
import { CommitField, layerBadge } from "./rows";

/**
 * The omp page's "Context files" section (issue #837): the extra
 * instruction files omp 18.8.8+ loads beside the usual context file,
 * the page's first editable array row — the generic row renders arrays
 * as a read-only JSON span (rows.tsx), which is why this key lives in a
 * dedicated group instead of OMP_SETTING_GROUPS.
 *
 * Every commit replaces the whole list: `omp config set` is
 * replace-not-merge for arrays, so each add/remove sends the full
 * merged array, the same discipline the record writers follow. Edits
 * target the Global layer like every other `omp config set` commit on
 * this page (omp's CLI has no project verb); a project-layer value
 * stays visible through the effective value plus its badge.
 */
export function ContextFilesSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The contextFiles.extra snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const t = useT();
  if (entry === undefined) return null;

  // entry.value is unvalidated JSON from omp; a non-array or non-string
  // member degrades to an empty list rather than crashing the page.
  const paths = Array.isArray(entry.value)
    ? entry.value.filter((v): v is string => typeof v === "string")
    : [];
  const pendingWrite = pendingKey === CONTEXT_FILES_EXTRA_KEY;

  const addPath = (raw: string): void => {
    const trimmed = raw.trim();
    // An empty or already-listed draft is not an edit; commit nothing.
    if (trimmed === "" || paths.includes(trimmed)) return;
    commit(CONTEXT_FILES_EXTRA_KEY, [...paths, trimmed]);
  };

  const removePath = (path: string): void => {
    commit(
      CONTEXT_FILES_EXTRA_KEY,
      paths.filter((p) => p !== path),
    );
  };

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.contextFiles")}</Label>
        {layerBadge(entry.layer)}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.contextFilesHint")}
      </p>
      <div className="mt-1.5 divide-y divide-line-soft">
        {paths.map((path) => (
          <div key={path} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-[11px] text-ink-mid" title={path}>
              {path}
            </span>
            <Button
              size="xs"
              variant="ghost"
              tone="rose"
              className="ml-auto"
              disabled={pendingWrite}
              onClick={() => removePath(path)}
            >
              {t("settings.omp.contextFilesRemove")}
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 py-1.5">
        <CommitField
          current=""
          kind="text"
          label={t("settings.omp.contextFilesAdd")}
          placeholder="AGENTS.local.md"
          disabled={pendingWrite}
          className="w-56 font-mono"
          onCommit={addPath}
        />
      </div>
    </section>
  );
}
