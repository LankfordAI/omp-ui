// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImageViewerHost, openImageViewer, type ViewerImage } from "./ImageViewer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// useOverlay's Sheet/Modal path touches ResizeObserver; jsdom has none.
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

let root: Root | null = null;

async function mount(): Promise<void> {
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ImageViewerHost />));
  // Drain the rAF useOverlay uses to hand focus to the scroll canvas.
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

const PNG = "data:image/png;base64,AAAB";
const JPEG = "data:image/jpeg;base64,BBAC";

function img(): HTMLImageElement | null {
  return document.body.querySelector<HTMLImageElement>('[role="dialog"] img');
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

/** Header buttons by their accessible label. */
function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
}

function fire(el: Element, init: EventInit & { key?: string }): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("ImageViewer", () => {
  it("opens on a dispatched event and renders the chosen image in a dialog", async () => {
    await mount();
    expect(dialog()).toBeNull();
    act(() => openImageViewer([{ src: PNG, mimeType: "image/png", label: "attached image 1" }], 0));
    expect(dialog()).not.toBeNull();
    expect(img()?.getAttribute("src")).toBe(PNG);
    expect(dialog()?.textContent).toContain("image 1 of 1");
  });

  it("ignores an open with no images", async () => {
    await mount();
    act(() => openImageViewer([], 0));
    expect(dialog()).toBeNull();
  });

  it("Escape closes the viewer and unmounts the portal", async () => {
    await mount();
    act(() => openImageViewer([{ src: PNG, mimeType: "image/png", label: "x" }], 0));
    expect(dialog()).not.toBeNull();
    fire(window, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(img()).toBeNull();
  });

  it("a backdrop pointer-down closes it", async () => {
    await mount();
    act(() => openImageViewer([{ src: PNG, mimeType: "image/png", label: "x" }], 0));
    const scrim = document.body.querySelector<HTMLElement>("[data-overlay-root]")!;
    act(() => scrim.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(dialog()).toBeNull();
  });

  it("steps with next/previous and disables each at its end", async () => {
    await mount();
    const images: ViewerImage[] = [
      { src: PNG, mimeType: "image/png", label: "1" },
      { src: JPEG, mimeType: "image/jpeg", label: "2" },
    ];
    act(() => openImageViewer(images, 0));
    const next = button("next image")!;
    const prev = button("previous image")!;
    expect(prev.disabled).toBe(true);
    expect(img()?.getAttribute("src")).toBe(PNG);

    act(() => next.click());
    expect(img()?.getAttribute("src")).toBe(JPEG);
    expect(dialog()?.textContent).toContain("image 2 of 2");
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
  });

  it("ArrowRight steps and stops at the last image", async () => {
    await mount();
    act(() =>
      openImageViewer(
        [
          { src: PNG, mimeType: "image/png", label: "1" },
          { src: JPEG, mimeType: "image/jpeg", label: "2" },
        ],
        0,
      ),
    );
    const canvas = document.body.querySelector<HTMLElement>("[data-modal-initial-focus]")!;
    fire(canvas, { key: "ArrowRight" });
    expect(img()?.getAttribute("src")).toBe(JPEG);
    fire(canvas, { key: "ArrowRight" });
    expect(img()?.getAttribute("src")).toBe(JPEG);
  });

  it("the fit toggle swaps the sizing class and reports dimensions after load", async () => {
    await mount();
    act(() => openImageViewer([{ src: PNG, mimeType: "image/png", label: "x" }], 0));
    const el = img()!;
    expect(el.className).toContain("object-contain");

    // jsdom never loads a data: URI, so hand it the intrinsic size the browser
    // would report and fire load.
    Object.defineProperty(el, "naturalWidth", { configurable: true, value: 1600 });
    Object.defineProperty(el, "naturalHeight", { configurable: true, value: 1900 });
    act(() => el.dispatchEvent(new Event("load")));
    expect(dialog()?.textContent).toContain("1600");
    expect(dialog()?.textContent).toContain("1900");

    act(() => button("actual size")!.click());
    const after = img()!;
    expect(after.className).not.toContain("object-contain");
    expect(after.className).toContain("cursor-zoom-out");
  });

  it("a failing load reports the undecodable caption", async () => {
    await mount();
    act(() => openImageViewer([{ src: PNG, mimeType: "image/png", label: "x" }], 0));
    act(() => img()!.dispatchEvent(new Event("error")));
    expect(dialog()?.textContent).toContain("this image could not be decoded");
  });

  it("the close button closes it", async () => {
    await mount();
    act(() => openImageViewer([{ src: PNG, mimeType: "image/png", label: "x" }], 0));
    act(() => button("close dialog")!.click());
    expect(dialog()).toBeNull();
  });
});
