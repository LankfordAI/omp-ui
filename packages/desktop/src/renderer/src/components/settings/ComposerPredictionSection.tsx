import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { COMPOSER_PREDICTION_SETTING_GROUP } from "@omp-ui/core/omp-settings-keys";
import { Label } from "../ui";
import { Row, SettingControl, layerBadge } from "./rows";

/**
 * The omp page's "Composer predictions" section (issue #1030): the boolean
 * rows for `composer.predictions` (published since omp 18.9.0) and
 * `composer.predictionAlternatives` (since omp 18.16.0), which drive omp's
 * own TUI composer prediction — the model's guess at your next message
 * ghosted in the empty composer, inserted on Tab/Right, never auto-sent.
 * This is NOT omp-ui's RPC word-ghost (#predict_word wire unchanged at
 * 18.16.0). The alternatives row is listed only while the master reads on,
 * mirroring omp's own `condition: "composerPredictionsEnabled"` listing rule
 * (upstream v18.16.0 modes/settings.ts); an omp that predates the master key
 * publishes nothing, hiding the section entirely.
 */
export function ComposerPredictionSection({
  masterEntry,
  alternativesEntry,
  pendingKey,
  commit,
}: {
  /** The composer.predictions snapshot entry; undefined when omp predates the key. */
  masterEntry: OmpSettingEntry | undefined;
  /** The composer.predictionAlternatives snapshot entry; undefined when omp predates it (pre-18.16). */
  alternativesEntry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  if (masterEntry === undefined) return null;

  return (
    <section className="px-4 pt-3">
      <Label>{COMPOSER_PREDICTION_SETTING_GROUP.title}</Label>
      <div className="mt-1 divide-y divide-line-soft">
        <Row
          title={masterEntry.key}
          hint={masterEntry.description}
          badge={layerBadge(masterEntry.layer)}
        >
          <SettingControl
            entry={masterEntry}
            pendingKey={pendingKey}
            commit={commit}
          />
        </Row>
        {masterEntry.value === true && alternativesEntry !== undefined && (
          <Row
            title={alternativesEntry.key}
            hint={alternativesEntry.description}
            badge={layerBadge(alternativesEntry.layer)}
          >
            <SettingControl
              entry={alternativesEntry}
              pendingKey={pendingKey}
              commit={commit}
            />
          </Row>
        )}
      </div>
    </section>
  );
}
