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
import { useT } from "../../lib/i18n";
import { PaletteEmpty, PaletteList, PaletteSearchHeader, usePaletteNav } from "../palette";
import { Button, Chevron, IconButton, IconClose, IconRefresh, IconSearch, Label, Modal } from "../ui";

type PickerRow =
  | { id: string; group: "running" | "stopped"; target: DeviceTarget; label: string; detail: string; reason: string | null }
  | { id: string; group: "create"; profile: DeviceProfileOffer; label: string; detail: string; reason: string | null };

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
  const t = useT();
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
        const detail = [target.avd, target.serial, target.api == null ? null : t("device.picker.api", { api: target.api })]
          .filter(Boolean).join(" · ");
        result.push({
          id: `${target.serial ?? "avd"}:${target.avd}`, group, target,
          label: target.friendlyName ?? target.avd,
          detail,
          reason: target.availabilityReason ?? (target.state === "booting" ? t("device.target.booting", { avd: target.avd }) : null),
        });
      }
    }
    for (const offer of inventory?.profiles ?? []) {
      result.push({ id: `create:${offer.id}`, group: "create", profile: offer, label: offer.name,
        detail: offer.id,
        reason: offer.available && inventory?.creation.available ? null : offer.reason ?? inventory?.creation.reason ?? t("device.picker.unavailable"),
      });
    }
    const needle = query.trim().toLocaleLowerCase();
    return needle === "" ? result : result.filter((row) => `${row.label} ${row.detail} ${row.reason ?? ""}`.toLocaleLowerCase().includes(needle));
  }, [inventory, query, t]);

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
  const creationReason = busy ? t("device.picker.busy")
    : profile === null || !profile.available || inventory?.creation.available !== true
      ? profile?.reason ?? inventory?.creation.reason ?? t("device.picker.unavailable")
      : profile.images.length === 0 ? t("device.picker.noImages") : null;
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
          <IconButton label={t("device.picker.back")} onClick={back} className="size-11 motion-reduce:transition-none">
            <Chevron open={false} className="rotate-180" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-medium text-ink">{profileId === null ? t("device.picker.title") : profile?.name ?? profileId}</h2>
          {profileId === null && <input ref={searchRef} data-modal-initial-focus value={query} onChange={(event) => setQuery(event.target.value)}
            aria-label={t("device.picker.search")} placeholder={t("device.picker.search")} spellCheck={false}
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
        <IconButton label={t("device.picker.close")} onClick={onClose} className="size-11 motion-reduce:transition-none"><IconClose /></IconButton>
      </PaletteSearchHeader>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5 py-1 text-xs text-ink-dim">
        <p className="min-w-0 flex-1 break-words">{t("device.picker.owner", { owner: ownerName })}</p>
        <IconButton label={t("device.picker.refresh")} disabled={disabled || state?.operation != null} onClick={onRefresh} className="size-11 motion-reduce:transition-none"><IconRefresh /></IconButton>
      </div>
      {profileId === null ? (
        <PaletteList className="min-h-0 flex-1">
          {rows.length === 0 && <PaletteEmpty title={t("device.picker.empty")} hint={t("device.picker.emptyHint")} />}
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {(index === 0 || rows[index - 1]?.group !== row.group) && <Label className="mt-2 block px-3.5 pb-1">{t(`device.picker.${row.group}`)}</Label>}
              <button type="button" ref={index === active ? activeRef : null} aria-disabled={busy || row.reason !== null}
                onMouseMove={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => pick(row)}
                onKeyDown={handleKey}
                className={cn("flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-line-strong", index === active ? "bg-hover" : "hover:bg-hover/50")}>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm", busy || row.reason !== null ? "text-ink-dim" : "text-ink")}>{row.label}</span>
                  <span className="block break-words text-xs text-ink-dim">{busy ? t("device.picker.busy") : row.reason ?? row.detail}</span>
                  {row.group !== "create" && row.target.layoutReference && <span className="block text-xs text-ink-dim">{t("device.picker.layoutReference", { name: row.target.layoutReference })} · {t("device.picker.screenSizeOnly")}</span>}
                </span>
                {row.group === "create" && <Chevron open={false} />}
              </button>
            </Fragment>
          ))}
        </PaletteList>
      ) : (
        <form className="min-h-0 space-y-4 overflow-y-auto px-3.5 py-4" onSubmit={(event) => { event.preventDefault(); create(); }}>
          <div><Label>{t("device.picker.profile")}</Label><p className="mt-1 text-sm text-ink">{profile?.name ?? profileId}</p></div>
          <div>
            <label htmlFor={imageId} className="block text-xs text-ink-dim">{t("device.picker.image")}</label>
            <select ref={imageRef} id={imageId} value={imagePackage} disabled={creationReason !== null}
              onChange={(event) => {
                const value = event.target.value;
                setImagePackage(value);
                const image = profile?.images.find((candidate) => candidate.packageId === value);
                if (image !== undefined && profile !== null && !nameEdited) setName(proposeAvdName(profile.id, image.api, inventory?.targets.map((target) => target.avd) ?? []));
              }} className="mt-1 min-h-11 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-line-strong focus:outline-none">
              <option value="" disabled>{t("device.picker.chooseImage")}</option>
              {profile?.images.map((image) => <option key={image.packageId} value={image.packageId}>{image.label} · {image.packageId}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={nameId} className="block text-xs text-ink-dim">{t("device.picker.name")}</label>
            <input id={nameId} value={name} onChange={(event) => { setName(event.target.value); setNameEdited(true); }} autoComplete="off" spellCheck={false}
              aria-invalid={!nameValid || nameExists} className="mt-1 min-h-11 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-line-strong focus:outline-none" />
            {(!nameValid || nameExists) && <p role="alert" className="mt-1 text-xs text-rose">{t(nameExists ? "device.picker.nameExists" : "device.picker.invalidName")}</p>}
          </div>
          <p className="text-xs leading-relaxed text-ink-dim">{t("device.picker.createHint")} {t("device.picker.separateData")}</p>
          {creationReason !== null && <p role="status" className="text-xs text-ink-dim">{creationReason}</p>}
          <Button type="submit" disabled={!canCreate} className="min-h-11 motion-reduce:transition-none">{t("device.picker.createStart")}</Button>
        </form>
      )}
      {inventory !== null && (inventory.creation.sdkRoot !== null || inventory.creation.reason !== null || inventory.creation.installCommand !== null) && (
        <div className="shrink-0 space-y-1 border-t border-line px-3.5 py-3 text-xs text-ink-dim">
          {inventory.creation.reason !== null && <p>{inventory.creation.reason}</p>}
          {inventory.creation.sdkRoot !== null && <p className="break-all">{t("device.picker.sdkRoot")}: {inventory.creation.sdkRoot}</p>}
          {inventory.creation.installCommand !== null && <><p>{t("device.picker.install", { owner: ownerName })}</p><code className="block select-text whitespace-pre-wrap break-all text-ink-mid">{inventory.creation.installCommand}</code></>}
        </div>
      )}
      {profileId === null && <p className="shrink-0 border-t border-line px-3.5 py-2 text-xs text-ink-faint">{t("device.picker.navigate")} · {t("device.picker.select")}</p>}
    </Modal>
  );
}
