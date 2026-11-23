import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DEVICE_AVD_PATTERN,
  proposeAvdName,
  type DeviceInventory,
  type DevicePaneAction,
  type DevicePaneState,
  type DeviceProfileOffer,
  type DeviceTarget,
} from "@omp-ui/core/device-pane";
import { cn } from "../../lib/cn";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "../palette";
import { Button, Chevron, IconButton, IconClose, IconRefresh, IconSearch, Label, Modal } from "../ui";

type PickerRow =
  | { id: string; group: "running" | "stopped"; target: DeviceTarget; label: string; detail: string; reason: string | null }
  | { id: string; group: "create"; profile: DeviceProfileOffer; label: string; detail: string; reason: string | null };

const PICKER_GROUP_LABEL: Record<PickerRow["group"], string> = {
  running: "Running",
  stopped: "Stopped",
  create: "Create device",
};

export interface DevicePickerProps {
  inventory: DeviceInventory | null;
  state: DevicePaneState | null;
  ownerName: string;
  disabled: boolean;
  onAction: (action: DevicePaneAction) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/** Browsing is read-only. Only the final create confirmation provisions an AVD. */
export function DevicePicker({ inventory, state, ownerName, disabled, onAction, onRefresh, onClose }: DevicePickerProps) {
  const titleId = useId();
  const imageId = useId();
  const nameId = useId();
  const [query, setQuery] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [imagePackage, setImagePackage] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLSelectElement>(null);
  const rootSelection = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const rootSearchFocused = useRef(true);
  const busy = disabled || state?.operation != null || state?.agent === "acting";
  const profile = inventory?.profiles.find((offer) => offer.id === profileId) ?? null;

  const rows = useMemo<PickerRow[]>(() => {
    const result: PickerRow[] = [];
    for (const group of ["running", "stopped"] as const) {
      for (const target of inventory?.targets ?? []) {
        if ((target.state === "stopped") !== (group === "stopped")) continue;
        const detail = [target.avd, target.serial, target.api == null ? null : `API ${target.api}`]
          .filter(Boolean).join(" · ");
        result.push({
          id: `${target.serial ?? "avd"}:${target.avd}`, group, target,
          label: target.friendlyName ?? target.avd,
          detail,
          reason: target.availabilityReason ?? (target.state === "booting" ? `${target.avd} · booting` : null),
        });
      }
    }
    for (const offer of inventory?.profiles ?? []) {
      result.push({ id: `create:${offer.id}`, group: "create", profile: offer, label: offer.name,
        detail: offer.id,
        reason: offer.available && inventory?.creation.available ? null : offer.reason ?? inventory?.creation.reason ?? "Unavailable",
      });
    }
    const needle = query.trim().toLocaleLowerCase();
    return needle === "" ? result : result.filter((row) => `${row.label} ${row.detail} ${row.reason ?? ""}`.toLocaleLowerCase().includes(needle));
  }, [inventory, query]);

  const back = (): void => setProfileId(null);
  const pick = (row: PickerRow): void => {
    if (busy || row.reason !== null) return;
    if (row.group === "create") {
      rootSelection.current = { start: searchRef.current?.selectionStart ?? query.length, end: searchRef.current?.selectionEnd ?? query.length };
      rootSearchFocused.current = document.activeElement === searchRef.current;
      setProfileId(row.profile.id);
      setImagePackage(row.profile.defaultImagePackage ?? "");
      setName(row.profile.proposedAvd);
      setNameEdited(false);
      return;
    }
    if (row.target.serial !== null) onAction({ action: "bind", serial: row.target.serial });
    else onAction({ action: "boot", avd: row.target.avd });
    onClose();
  };
  const { active, activeRef, setActive, handleKey } = usePaletteNav({ items: rows, resetKey: query, onPick: pick, onClose });

  useEffect(() => {
    if (profileId !== null) {
      imageRef.current?.focus();
      return;
    }
    const input = searchRef.current;
    if (rootSearchFocused.current) input?.focus();
    else activeRef.current?.focus();
    input?.setSelectionRange(rootSelection.current.start, rootSelection.current.end);
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [profileId]);

  const selectedImage = profile?.images.find((image) => image.packageId === imagePackage);
  const nameValid = new RegExp(DEVICE_AVD_PATTERN).test(name);
  const nameExists = inventory?.targets.some((target) => target.avd === name) === true;
  const creationReason = busy ? "Wait for the current device operation."
    : profile === null || !profile.available || inventory?.creation.available !== true
      ? profile?.reason ?? inventory?.creation.reason ?? "Unavailable"
      : profile.images.length === 0 ? "No compatible installed system images." : null;
  const canCreate = creationReason === null && selectedImage !== undefined && nameValid && !nameExists;
  const create = (): void => {
    if (!canCreate || profile === null || selectedImage === undefined) return;
    onAction({ action: "create", profileId: profile.id, imagePackage: selectedImage.packageId, avd: name });
    onClose();
  };

  return (
    <Modal onClose={profileId === null ? onClose : back} labelledBy={titleId} width="w-[36rem]" className="flex flex-col motion-reduce:animate-none">
      <PaletteSearchHeader className="shrink-0 py-1.5">
        {profileId === null ? <IconSearch className="size-4 shrink-0 text-ink-dim" /> : (
          <IconButton label="Back to devices" onClick={back} className="size-11 motion-reduce:transition-none">
            <Chevron open={false} className="rotate-180" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-medium text-ink">{profileId === null ? "Choose Android device" : profile?.name ?? profileId}</h2>
          {profileId === null && <input ref={searchRef} data-modal-initial-focus value={query} onChange={(event) => setQuery(event.target.value)}
            aria-label="Search devices and profiles" placeholder="Search devices and profiles" spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && query === "") { event.preventDefault(); onClose(); return; }
              if (event.key === "ArrowRight" && event.currentTarget.selectionStart === query.length) {
                const row = rows[active];
                if (row?.group === "create") { event.preventDefault(); pick(row); return; }
              }
              handleKey(event);
            }}
            className="h-11 w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none" />}
        </div>
        <IconButton label="Close device picker" onClick={onClose} className="size-11 motion-reduce:transition-none"><IconClose /></IconButton>
      </PaletteSearchHeader>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5 py-1 text-xs text-ink-dim">
        <p className="min-w-0 flex-1 break-words">{`Devices and setup on ${ownerName}`}</p>
        <IconButton label="Refresh devices" disabled={disabled || state?.operation != null} onClick={onRefresh} className="size-11 motion-reduce:transition-none"><IconRefresh /></IconButton>
      </div>
      {profileId === null ? (
        <PaletteList className="min-h-0 flex-1">
          {rows.length === 0 && <PaletteEmpty title="No matching devices" hint="Try another device or profile name." />}
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {(index === 0 || rows[index - 1]?.group !== row.group) && <Label className="mt-2 block px-3.5 pb-1">{PICKER_GROUP_LABEL[row.group]}</Label>}
              <button type="button" ref={index === active ? activeRef : null} aria-disabled={busy || row.reason !== null}
                onMouseMove={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => pick(row)}
                onKeyDown={handleKey}
                className={cn("flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-line-strong", index === active ? "bg-hover" : "hover:bg-hover/50")}>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm", busy || row.reason !== null ? "text-ink-dim" : "text-ink")}>{row.label}</span>
                  <span className="block break-words text-xs text-ink-dim">{busy ? "Wait for the current device operation." : row.reason ?? row.detail}</span>
                  {row.group !== "create" && row.target.layoutReference && <span className="block text-xs text-ink-dim">{`Layout reference: ${row.target.layoutReference}`} · Screen size only — does not fold</span>}
                </span>
                {row.group === "create" && <Chevron open={false} />}
              </button>
            </Fragment>
          ))}
        </PaletteList>
      ) : (
        <form className="min-h-0 space-y-4 overflow-y-auto px-3.5 py-4" onSubmit={(event) => { event.preventDefault(); create(); }}>
          <div><Label>Device profile</Label><p className="mt-1 text-sm text-ink">{profile?.name ?? profileId}</p></div>
          <div>
            <label htmlFor={imageId} className="block text-xs text-ink-dim">System image</label>
            <select ref={imageRef} id={imageId} value={imagePackage} disabled={creationReason !== null}
              onChange={(event) => {
                const value = event.target.value;
                setImagePackage(value);
                const image = profile?.images.find((candidate) => candidate.packageId === value);
                if (image !== undefined && profile !== null && !nameEdited) setName(proposeAvdName(profile.id, image.api, inventory?.targets.map((target) => target.avd) ?? []));
              }} className="mt-1 min-h-11 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-line-strong focus:outline-none">
              <option value="" disabled>Choose an installed system image</option>
              {profile?.images.map((image) => <option key={image.packageId} value={image.packageId}>{image.label} · {image.packageId}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={nameId} className="block text-xs text-ink-dim">Device name</label>
            <input id={nameId} value={name} onChange={(event) => { setName(event.target.value); setNameEdited(true); }} autoComplete="off" spellCheck={false}
              aria-invalid={!nameValid || nameExists} className="mt-1 min-h-11 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-line-strong focus:outline-none" />
            {(!nameValid || nameExists) && <p role="alert" className="mt-1 text-xs text-rose">{nameExists ? "A device with this name already exists." : "Use letters, numbers, dots, underscores or hyphens."}</p>}
          </div>
          <p className="text-xs leading-relaxed text-ink-dim">Nothing is created until you confirm. New devices have separate app data; existing devices are unchanged.</p>
          {creationReason !== null && <p role="status" className="text-xs text-ink-dim">{creationReason}</p>}
          <Button type="submit" disabled={!canCreate} className="min-h-11 motion-reduce:transition-none">Create and start</Button>
        </form>
      )}
      {inventory !== null && (inventory.creation.sdkRoot !== null || inventory.creation.reason !== null || inventory.creation.installCommand !== null) && (
        <div className="shrink-0 space-y-1 border-t border-line px-3.5 py-3 text-xs text-ink-dim">
          {inventory.creation.reason !== null && <p>{inventory.creation.reason}</p>}
          {inventory.creation.sdkRoot !== null && <p className="break-all">SDK location: {inventory.creation.sdkRoot}</p>}
          {inventory.creation.installCommand !== null && <><p>{`Run on ${ownerName}`}</p><code className="block select-text whitespace-pre-wrap break-all text-ink-mid">{inventory.creation.installCommand}</code></>}
        </div>
      )}
      {profileId === null && <p className="shrink-0 border-t border-line px-3.5 py-2 text-xs text-ink-faint">Arrow keys to navigate · Enter to select</p>}
    </Modal>
  );
}
