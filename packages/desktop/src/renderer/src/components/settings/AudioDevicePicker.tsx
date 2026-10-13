import type { AudioDevicesSnapshot } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";

export type AudioDevicesLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: AudioDevicesSnapshot };

/**
 * The app-wide audio device (issue #855). The rows come from pactl — never
 * curated here — and the picker is display truth from `devices` + `current`,
 * never an optimistic patch (the omp-page snapshot rule). A stored label the
 * live list no longer carries stays visible, pressed and labelled "(not
 * connected)", so the choice isn't silently lost; it re-resolves at the next
 * start or an explicit re-pick. When `supported` is false (pactl absent, or a
 * platform v1 doesn't drive) the picker collapses to the disabled system
 * default and the row hint says why.
 */
export function AudioDevicePicker({
  value,
  load,
  onSelect,
}: {
  value: string | null;
  load: AudioDevicesLoad;
  onSelect: (id: string | null) => void;
}) {
  const t = useT();
  if (load.status === "loading") {
    return <p className="text-[11px] text-ink-faint">{t("settings.omp.reading")}</p>;
  }
  const { snapshot } = load;
  if (!snapshot.supported) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <div
          role="group"
          aria-label={t("settings.general.audioDevice")}
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
        {snapshot.error !== null && (
          <p className="text-[10px] text-ink-faint">
            {t("settings.general.dictationLoadFailed", { message: snapshot.error })}
          </p>
        )}
      </div>
    );
  }
  const options: Array<{ id: string | null; label: string; chip: string | null }> = [
    { id: null, label: t("settings.general.audioDeviceSystemDefault"), chip: null },
  ];
  if (value !== null && !snapshot.devices.some((device) => device.id === value)) {
    options.push({
      id: value,
      label: `${value} ${t("settings.general.audioDeviceNotConnected")}`,
      chip: null,
    });
  }
  for (const device of snapshot.devices) {
    const kind =
      device.hasInput && device.hasOutput
        ? t("settings.general.audioDeviceInputOutput")
        : device.hasInput
          ? t("settings.general.audioDeviceInput")
          : t("settings.general.audioDeviceOutput");
    options.push({ id: device.id, label: `${device.id} ${kind}`, chip: device.isDefault ? t("settings.general.audioDeviceDefaultChip") : null });
  }
  return (
    <div
      role="group"
      aria-label={t("settings.general.audioDevice")}
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
              if (option.id !== value) onSelect(option.id);
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
  );
}
