// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInventory, DeviceSystemImage } from "@omp-ui/core/device-pane";
import { applyLocale, resolveLocale } from "../../lib/i18n";
import { DevicePicker } from "./DevicePicker";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const images: DeviceSystemImage[] = [
  { packageId: "system-images;android-35;google_apis;x86_64", api: 35, abi: "x86_64", tag: "google_apis", label: "Android 35 Google APIs" },
  { packageId: "system-images;android-36;google_apis;x86_64", api: 36, abi: "x86_64", tag: "google_apis", label: "Android 36 Google APIs" },
];
function inventory(): DeviceInventory {
  return {
    sdk: { status: "ready", sdkRoot: "/opt/android-sdk" },
    targets: [{ serial: "emulator-5580", avd: "claimed_phone", state: "running", availabilityReason: "In use by another tab" }],
    profiles: [{ id: "pixel_fold", name: "Pixel Fold", family: "book", minApi: 34, available: true, reason: null, images, defaultImagePackage: images[0]!.packageId, proposedAvd: "Pixel_Fold" }],
    images,
    creation: { available: true, reason: null, sdkRoot: "/opt/android-sdk", installCommand: null },
  };
}
let root: Root;
let host: HTMLDivElement;
const onAction = vi.fn();
const onClose = vi.fn();
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.includes(label) || element.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function click(element: Element) {
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  act(() => { element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
beforeEach(() => {
  applyLocale(resolveLocale("en"));
  onAction.mockClear();
  onClose.mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<DevicePicker inventory={inventory()} state={null} ownerName="Local machine" disabled={false} onAction={onAction} onRefresh={vi.fn()} onClose={onClose} />); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
describe("DevicePicker creation confirmation", () => {
  it("creates with the owner recommendation only after explicit confirmation", () => {
    click(button("Pixel Fold"));
    expect(onAction).not.toHaveBeenCalled();
    click(button("Create and start"));
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "create", profileId: "pixel_fold", imagePackage: images[0]!.packageId, avd: "Pixel_Fold" });
  });
  it("preserves the root search when returning from a profile without provisioning", () => {
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search devices and profiles"]');
    if (!search) throw new Error("Device search is missing");
    change(search, "Fold");
    click(button("Pixel Fold"));
    click(button("Back to devices"));
    const restored = document.querySelector<HTMLInputElement>('input[aria-label="Search devices and profiles"]');
    expect(restored?.value).toBe("Fold");
    expect(document.activeElement).toBe(restored);
    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("browses a profile without creating, then creates only the explicitly selected image and name", () => {
    click(button("Pixel Fold"));
    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const confirm = button("Create and start");
    expect(confirm.disabled).toBe(false);
    const image = document.querySelector("select");
    const name = document.querySelector<HTMLInputElement>('input:not([type="hidden"])');
    if (!image || !name) throw new Error("Creation image and name fields are missing");
    expect(image.value).toBe(images[0]!.packageId);
    change(image, images[1]!.packageId);
    change(name, "fold_workspace");
    expect(onAction).not.toHaveBeenCalled();
    expect(confirm.disabled).toBe(false);
    click(confirm);
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "create", profileId: "pixel_fold", imagePackage: images[1]!.packageId, avd: "fold_workspace" });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("returns from profile details without creating and cannot select a claimed device", () => {
    const claimed = button("claimed_phone");
    expect(claimed.disabled || claimed.getAttribute("aria-disabled") === "true").toBe(true);
    click(claimed);
    expect(onAction).not.toHaveBeenCalled();
    click(button("Pixel Fold"));
    click(button("Back to devices"));
    expect(button("claimed_phone")).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
