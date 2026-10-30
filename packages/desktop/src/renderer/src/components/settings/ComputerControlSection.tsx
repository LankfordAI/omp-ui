import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { COMPUTER_CONTROL_POLICY } from "@omp-ui/core/omp-settings-keys";
import { useStore } from "../../store";
import { supportsComputerControlPolicy } from "../../lib/computer-control";
import { useT } from "../../lib/i18n";
import { Chip, Label } from "../ui";
import { FIELD, Row } from "./rows";

type ControlChoice = "ask" | "allow" | "deny";
const CHOICES: readonly ControlChoice[] = ["ask", "allow", "deny"];

/** omp's own reading of a policy entry: trimmed, lowercased, and anything but
 *  allow/deny — `prompt`, a typo, no entry, or no record — leaves the request asking. */
function choiceOf(record: OmpSettingValue | undefined): ControlChoice {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return "ask";
  const raw = record[COMPUTER_CONTROL_POLICY];
  const policy = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return policy === "allow" || policy === "deny" ? policy : "ask";
}

/**
 * The omp page's "Computer control" section (omp 18.14.0, issue #976): the
 * `computer.control` entry of omp's `tools.approval` policy record, which
 * answers the computer tool's foreground-control requests — `allow` or `deny`
 * without prompting, for dedicated fleet members nobody is watching.
 *
 * Global layer only, like Restricted folders. `omp config set` REPLACES the
 * record and the entry name is one literal dotted key (both verified on
 * 18.14.0), so a write spreads the whole global record back — ADR-0031
 * discipline — with `ask` removing the entry rather than writing `prompt`. The
 * merge base is globalValue, never the effective value, so a project layer's
 * policies are not baked into the global file. An older omp ignores the entry,
 * so the section stays hidden below 18.14.0.
 */
export function ComputerControlSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The tools.approval snapshot entry; undefined when omp does not publish it. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const t = useT();
  const supported = useStore((s) => supportsComputerControlPolicy(s.ompUpdate.installedVersion));
  if (entry === undefined || !supported) return null;

  const stored = entry.globalValue;
  const record =
    typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
  const globalChoice = choiceOf(record);
  const effectiveChoice = choiceOf(entry.value);
  const projectWins = effectiveChoice !== globalChoice;

  const pick = (raw: string): void => {
    if (raw !== "ask" && raw !== "allow" && raw !== "deny") return;
    if (raw === globalChoice) return;
    const { [COMPUTER_CONTROL_POLICY]: _dropped, ...siblings } = record;
    commit(entry.key, raw === "ask" ? siblings : { ...siblings, [COMPUTER_CONTROL_POLICY]: raw });
  };

  return (
    <section className="px-4 pt-3">
      <Label>{t("settings.omp.computerControl")}</Label>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.computerControlHint")}
      </p>
      <div className="mt-1 divide-y divide-line-soft">
        <Row
          title={`${entry.key}["${COMPUTER_CONTROL_POLICY}"]`}
          hint={
            projectWins
              ? t("settings.omp.computerControlProjectWins", { value: effectiveChoice })
              : undefined
          }
          badge={
            projectWins ? (
              <Chip tone="copper">project</Chip>
            ) : globalChoice !== "ask" ? (
              <Chip>global</Chip>
            ) : null
          }
        >
          <select
            aria-label={COMPUTER_CONTROL_POLICY}
            value={globalChoice}
            disabled={pendingKey === entry.key}
            onChange={(event) => pick(event.target.value)}
            className={FIELD}
          >
            {CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t(`settings.omp.computerControl.${choice}`)}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </section>
  );
}
