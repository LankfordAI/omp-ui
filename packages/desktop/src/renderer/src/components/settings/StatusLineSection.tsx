import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { useT } from "../../lib/i18n";
import { Label, Switch } from "../ui";
import { Row, layerBadge } from "./rows";

/**
 * The omp page's "Status line" section (issue #887): the single published
 * opt-out nested in `statusLine.segmentOptions`, `pi.showProfile`. omp's CLI
 * cannot address the nested dot path and a record write is REPLACE-not-merge
 * (both verified against omp 18.12.2), so this row edits ONE boolean field by
 * spreading the whole global record back — ADR-0031 discipline — and an omp
 * that predates the key publishes nothing, hiding the section entirely.
 */
export function StatusLineSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The statusLine.segmentOptions snapshot entry; undefined when omp predates it. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const t = useT();
  if (entry === undefined) return null;

  // omp's documented default is `true`: an absent record, absent `pi`, or
  // absent `showProfile` all mean the profile name shows next to the brand.
  // Merge against globalValue, never the effective value, so a project-layer
  // record is not baked into the global file (ADR-0031).
  const record =
    typeof entry.globalValue === "object" &&
    entry.globalValue !== null &&
    !Array.isArray(entry.globalValue)
      ? entry.globalValue
      : {};
  const pi =
    typeof record["pi"] === "object" &&
    record["pi"] !== null &&
    !Array.isArray(record["pi"])
      ? (record["pi"] as Record<string, unknown>)
      : {};
  const showProfile = pi["showProfile"] !== false;

  const commitShowProfile = (value: boolean): void => {
    // Spread both levels so every sibling segment option round-trips intact.
    commit(entry.key, { ...record, pi: { ...pi, showProfile: value } });
  };

  return (
    <section className="px-4 pt-3">
      <Label>{t("settings.omp.statusLine")}</Label>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.statusLineHint")}
      </p>
      <div className="mt-1 divide-y divide-line-soft">
        <Row
          title={t("settings.omp.statusLineShowProfile")}
          hint={entry.description}
          badge={layerBadge(entry.layer)}
        >
          <Switch
            on={showProfile}
            onChange={(next) => commitShowProfile(next)}
            label={entry.key}
            disabled={pendingKey === entry.key}
          />
        </Row>
      </div>
    </section>
  );
}
