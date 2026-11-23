import { useState } from "react";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import {
  PAUSED_PROVIDER_SPECS,
  UNPAUSED_PROVIDERS_KEY,
} from "@omp-ui/core/omp-settings-keys";
import { Button, Chip, Label } from "../ui";
import { layerBadge } from "./rows";

/** String members of an unvalidated omp array; anything else degrades to []. */
const strings = (v: OmpSettingValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];

/**
 * The omp page's "Unpaused providers" section (omp 18.19+, issue #1206):
 * `auth.unpausedProviders`, the paused providers the user turned back on.
 * Each pause names an account risk, so enabling is a two-step acceptance: the
 * row states omp's own reason verbatim, and the second click carries it
 * ("accept the risk" — mirroring omp's own settings editor, which presents
 * every choice with its `disabled "<reason>"` text).
 *
 * Global layer only, like Restricted folders: omp applies operator layers
 * exclusively (`cfgOperatorUnpausedProviders`), so a project config can never
 * unpause a provider, and the generic row's whole-list replace semantics stay
 * against `entry.globalValue`, never the effective value (ADR-0031). The
 * curated roster is PAUSED_PROVIDER_SPECS; an id the stored list holds that
 * the roster does not name still renders, remove-only, so a newer omp that
 * pauses another provider loses no escape hatch. An older omp publishes no
 * entry, so the section stays hidden.
 */
export function UnpausedProvidersSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The auth.unpausedProviders snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  /** id whose second acceptance click is armed; null when nothing awaits. */
  const [accepting, setAccepting] = useState<string | null>(null);
  if (entry === undefined) return null;

  const globalList = strings(entry.globalValue);
  const effective = strings(entry.value);
  const pendingWrite = pendingKey === UNPAUSED_PROVIDERS_KEY;

  const write = (next: string[]): void => {
    setAccepting(null);
    commit(UNPAUSED_PROVIDERS_KEY, next);
  };

  // Stored ids outside the curated roster render after it, remove-only.
  const specIds = new Set(PAUSED_PROVIDER_SPECS.map((spec) => spec.id));
  const otherIds = globalList.filter((id) => !specIds.has(id));

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>Unpaused providers</Label>
        {layerBadge(entry.layer)}
      </div>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
        Providers omp paused, turned back on: login, token refresh and stored credentials work again (omp 18.19+). Each pause names the account risk you accept by re-enabling it — read it before accepting. Global only: a project's .omp/config.yml can never unpause a provider. Changes apply to sessions started afterwards.
      </p>
      {entry.layer === "project" && (
        <p className="mt-1 rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-xs text-copper">
          {`This project's .omp/config.yml lists its own unpaused providers, which omp disregards — only global settings unpause: ${effective.length === 0 ? "[]" : effective.join(", ")}`}
        </p>
      )}
      <div className="mt-1 divide-y divide-line-soft">
        {PAUSED_PROVIDER_SPECS.map((spec) => {
          const on = globalList.includes(spec.id);
          return (
            <div key={spec.id} className="py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{spec.label}</span>
                    {on && <Chip tone="copper">unpaused</Chip>}
                  </div>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">{spec.risk}</p>
                </div>
                {on ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    tone="rose"
                    disabled={pendingWrite}
                    onClick={() => write(globalList.filter((id) => id !== spec.id))}
                  >
                    pause again
                  </Button>
                ) : accepting === spec.id ? (
                  <Button
                    size="xs"
                    tone="rose"
                    disabled={pendingWrite}
                    onClick={() => write([...globalList, spec.id])}
                  >
                    accept the risk and enable
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pendingWrite}
                    onClick={() => setAccepting(spec.id)}
                  >
                    enable…
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {otherIds.map((id) => (
          <div key={id} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-ink-mid" title={id}>
              {id}
            </span>
            <Button
              size="xs"
              variant="ghost"
              tone="rose"
              className="ml-auto"
              disabled={pendingWrite}
              onClick={() => write(globalList.filter((stored) => stored !== id))}
            >
              pause again
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
