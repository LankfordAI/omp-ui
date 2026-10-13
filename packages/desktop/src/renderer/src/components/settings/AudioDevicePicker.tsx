import type { AudioDeviceRole, AudioDevicesSnapshot } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";

export type AudioDevicesLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: AudioDevicesSnapshot };

/**
 * The app-wide audio devices by role (issue #857): one headed list per role,
 * each pressing against its own stored value. The rows come from pactl —
 * never curated here — and the picker is display truth from `devices` +
 * `currentInput` / `currentOutput`, never an optimistic patch (the omp-page
 * snapshot rule). A stored label the live list no longer carries for that
 * role stays visible, pressed and labelled "(not connected)", so the choice
 * isn't silently lost; it re-resolves at the next start or an explicit
 * re-pick. A dual-role card appears in both lists. When `supported` is false
 * (pactl absent, or a platform v1 doesn't drive) both lists collapse to a
 * disabled system default and the row hint says why.
 */
export function AudioDevicePicker({
  valueInput,
  valueOutput,
  load,
  onSelect,
}: {
  valueInput: string | null;
  valueOutput: string | null;
  load: AudioDevicesLoad;
  onSelect: (role: AudioDeviceRole, id: string | null) => void;
}) {
  const t = useT();
  if (load.status === "loading") {
    return <p className="text-[11px] text-ink-faint">{t("settings.omp.reading")}</p>;
  }
  const { snapshot } = load;
  const roleLabel: Record<AudioDeviceRole, string> = {
    input: t("settings.general.audioDeviceInput"),
    output: t("settings.general.audioDeviceOutput"),
  };
  if (!snapshot.supported) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {(["input", "output"] as const).map((role) => (
          <div key={role} className="flex min-w-0 flex-col gap-1">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">
              {roleLabel[role]}
            </p>
            <div
              role="group"
              aria-label={roleLabel[role]}
              className="divide-y divide-line-soft rounded-md border border-line bg-raised"
            >
              <button
                type="button"
                aria-pressed={true}
                disabled
                className="flex w-full cursor-not-allowed items-center gap-2 px-2.5 py-1.5 text-left opacity-45"
              >
                <span className="min-w-0 truncate text-xs font-medium">
                  {t("settings.general.audioDeviceSystemDefault")}
                </span>
              </button>
            </div>
          </div>
        ))}
        {snapshot.error !== null && (
          <p className="text-[10px] text-ink-faint">
            {t("settings.general.dictationLoadFailed", { message: snapshot.error })}
          </p>
        )}
      </div>
    );
  }
  const valueFor: Record<AudioDeviceRole, string | null> = {
    input: valueInput,
    output: valueOutput,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {(["input", "output"] as const).map((role) => {
        const value = valueFor[role];
        const capable = snapshot.devices.filter((device) =>
          role === "input" ? device.hasInput : device.hasOutput,
        );
        const options: Array<{ id: string | null; label: string; chip: string | null }> = [
          { id: null, label: t("settings.general.audioDeviceSystemDefault"), chip: null },
        ];
        // Capability-aware: a stored label with no live node for this role —
        // absent entirely, or present only as the other role's device — is
        // "not connected" for this list.
        if (value !== null && !capable.some((device) => device.id === value)) {
          options.push({
            id: value,
            label: `${value} ${t("settings.general.audioDeviceNotConnected")}`,
            chip: null,
          });
        }
        for (const device of capable) {
          options.push({
            id: device.id,
            label: device.id,
            chip: (role === "input" ? device.isDefaultInput : device.isDefaultOutput)
              ? t("settings.general.audioDeviceDefaultChip")
              : null,
          });
        }
        return (
          <div key={role} className="flex min-w-0 flex-col gap-1">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">{roleLabel[role]}</p>
            <div
              role="group"
              aria-label={roleLabel[role]}
              className="divide-y divide-line-soft rounded-md border border-line bg-raised"
            >
              {options.map((option) => {
                const selected = option.id === value;
                return (
                  <button
                    key={option.id ?? "system"}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      if (option.id !== value) onSelect(role, option.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150",
                      selected
                        ? "bg-hover text-ink"
                        : "text-ink-mid hover:bg-hover/50 focus-visible:bg-hover/50 focus-visible:outline-none",
                    )}
                  >
                    <span className={cn("min-w-0 truncate text-xs", selected && "font-medium")}>
                      {option.label}
                    </span>
                    {option.chip !== null && (
                      <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-faint">
                        {option.chip}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
