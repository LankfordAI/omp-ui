import { useState } from "react";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { RESTRICTED_FOLDERS_KEY } from "@omp-ui/core/omp-settings-keys";
import { useT } from "../../lib/i18n";
import { DirectoryPicker } from "../DirectoryPicker";
import { Button, Label } from "../ui";
import { CommitField, layerBadge } from "./rows";

/** String members of an unvalidated omp array; anything else degrades to []. */
const strings = (v: OmpSettingValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];

/**
 * The omp page's "Restricted folders" section (issue #951): omp 18.13.1+'s
 * `tools.restrictedFolders`, folders where every action asks for approval in
 * every approval mode, yolo included. The generic row renders arrays as a
 * read-only JSON span (rows.tsx), so this section owns the editable row.
 *
 * omp marks the key global-only (`restrictedFoldersNotProject`), and
 * `omp config set` replaces the whole array, so every add/remove sends the
 * full list built from `entry.globalValue`, never the effective value
 * (ADR-0031). When a project layer wins, the Global list stays editable and a
 * notice shows what omp actually resolves.
 */
export function RestrictedFoldersSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The tools.restrictedFolders snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  if (entry === undefined) return null;

  const paths = strings(entry.globalValue);
  const effective = strings(entry.value);
  const pendingWrite = pendingKey === RESTRICTED_FOLDERS_KEY;

  const addPath = (raw: string): void => {
    const trimmed = raw.trim();
    // An empty or already-listed draft is not an edit; commit nothing.
    if (trimmed === "" || paths.includes(trimmed)) return;
    commit(RESTRICTED_FOLDERS_KEY, [...paths, trimmed]);
  };

  const removePath = (path: string): void => {
    commit(
      RESTRICTED_FOLDERS_KEY,
      paths.filter((p) => p !== path),
    );
  };

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.restrictedFolders")}</Label>
        {layerBadge(entry.layer)}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.restrictedFoldersHint")}
      </p>
      {entry.layer === "project" && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] text-copper">
          {t("settings.omp.restrictedFoldersProjectOverride", {
            paths: effective.length === 0 ? "[]" : effective.join(", "),
          })}
        </p>
      )}
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
              {t("settings.omp.restrictedFoldersRemove")}
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 py-1.5">
        <CommitField
          current=""
          kind="text"
          label={t("settings.omp.restrictedFoldersAdd")}
          placeholder="~/secrets"
          disabled={pendingWrite}
          className="w-56 font-mono"
          onCommit={addPath}
        />
        <Button size="xs" variant="ghost" disabled={pendingWrite} onClick={() => setPicking(true)}>
          {t("settings.omp.restrictedFoldersBrowse")}
        </Button>
      </div>
      {picking && (
        <DirectoryPicker
          mode="folder"
          instanceId={null}
          banner={null}
          onClose={() => setPicking(false)}
          onSubmit={async (path) => {
            addPath(path);
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}
