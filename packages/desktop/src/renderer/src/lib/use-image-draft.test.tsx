// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImageDraft } from "./use-image-draft";

const clipboardImageMock = vi.hoisted(() => ({
  hasClipboardImage: vi.fn(() => false),
  readClipboardImages: vi.fn(),
  readImageFiles: vi.fn(),
}));

vi.mock("./clipboard-image", () => clipboardImageMock);

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };

/** The reader is mocked, so any stand-in object carries the paste through. */
const CLIP = {} as unknown as DataTransfer;

/** A textarea + picker + state readout wired to the hook. */
function Probe() {
  const draft = useImageDraft();
  return (
    <div>
      <textarea data-testid="box" onPaste={(e) => void draft.onPaste(e)} />
      <input data-testid="picker" type="file" onChange={(e) => void draft.pickImages(e)} />
      <span data-testid="count">{draft.images.length}</span>
      <span data-testid="error">{draft.pasteError ?? ""}</span>
      {draft.images.map((image, i) => (
        <button key={i} data-testid={`drop-${i}`} onClick={() => draft.dropImage(i)}>
          {image.data}
        </button>
      ))}
      <button data-testid="clear" onClick={draft.clearImages}>
        clear
      </button>
      <button data-testid="dismiss" onClick={draft.dismissError}>
        dismiss
      </button>
    </div>
  );
}

let root: Root | null = null;

function mount(): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
}

const byId = (id: string): HTMLElement =>
  document.querySelector(`[data-testid="${id}"]`)!;

function paste(): Event {
  // jsdom has no ClipboardEvent constructor; React's synthetic wrapper only
  // needs the "paste" type and the clipboardData property.
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: CLIP });
  act(() => {
    (byId("box") as HTMLTextAreaElement).dispatchEvent(event);
  });
  return event;
}

async function pick(files: File[], value: string): Promise<void> {
  const input = byId("picker") as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    Object.defineProperty(input, "value", { configurable: true, writable: true, value });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  clipboardImageMock.hasClipboardImage.mockReset().mockReturnValue(false);
  clipboardImageMock.readClipboardImages.mockReset();
  clipboardImageMock.readImageFiles.mockReset().mockResolvedValue({ images: [], rejected: [] });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("useImageDraft paste", () => {
  it("intercepts an image paste, appends in order, and joins rejections", async () => {
    clipboardImageMock.hasClipboardImage.mockReturnValue(true);
    clipboardImageMock.readClipboardImages.mockResolvedValue({
      images: [IMAGE_ONE, IMAGE_TWO],
      rejected: [
        "big.png is 30.0 MB — over omp's 20 MB image limit",
        "odd.png could not be read",
      ],
    });
    mount();

    const event = paste();

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardImageMock.readClipboardImages).toHaveBeenCalledWith(CLIP);
    await act(async () => {});
    expect(byId("count").textContent).toBe("2");
    expect(byId("error").textContent).toBe(
      "big.png is 30.0 MB — over omp's 20 MB image limit; odd.png could not be read",
    );
  });

  it("leaves a text-only paste untouched", async () => {
    mount();

    const event = paste();

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardImageMock.readClipboardImages).not.toHaveBeenCalled();
    await act(async () => {});
    expect(byId("count").textContent).toBe("0");
    expect(byId("error").textContent).toBe("");
  });

  it("clears a prior refusal when the next read is clean", async () => {
    clipboardImageMock.readImageFiles
      .mockResolvedValueOnce({ images: [], rejected: ["broken.png could not be read"] })
      .mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] });
    mount();

    await pick([new File(["broken"], "broken.png", { type: "image/png" })], "broken-selection");
    expect(byId("error").textContent).toBe("broken.png could not be read");
    await pick([new File(["one"], "one.png", { type: "image/png" })], "clean-selection");

    expect(byId("error").textContent).toBe("");
    expect(byId("count").textContent).toBe("1");
  });
});

describe("useImageDraft picker", () => {
  it("clears the input before the read resolves, so the same file can be picked twice", async () => {
    // Executor form required: this tsconfig's lib predates Promise.withResolvers.
    let resolveRead!: (value: { images: typeof IMAGE_ONE[]; rejected: string[] }) => void;
    clipboardImageMock.readImageFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] });
    mount();
    const input = byId("picker") as HTMLInputElement;
    const file = new File(["one"], "one.png", { type: "image/png" });

    act(() => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      Object.defineProperty(input, "value", {
        configurable: true,
        writable: true,
        value: "first-selection",
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // The read is still in flight; the value must already be cleared.
    expect(input.value).toBe("");
    await act(async () => {
      resolveRead({ images: [IMAGE_ONE], rejected: [] });
    });
    await pick([file], "same-file-selection");

    expect(clipboardImageMock.readImageFiles).toHaveBeenNthCalledWith(1, [file]);
    expect(clipboardImageMock.readImageFiles).toHaveBeenNthCalledWith(2, [file]);
    expect(byId("count").textContent).toBe("2");
  });

  it("surfaces picker rejections without adding an image", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({
      images: [],
      rejected: ["broken.png could not be read"],
    });
    mount();

    await pick([new File(["broken"], "broken.png", { type: "image/png" })], "rejected-selection");

    expect(byId("error").textContent).toBe("broken.png could not be read");
    expect(byId("count").textContent).toBe("0");
  });
});

describe("useImageDraft edits", () => {
  it("drops one image by index and keeps the rest in order", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValue({
      images: [IMAGE_ONE, IMAGE_TWO],
      rejected: [],
    });
    mount();
    await pick(
      [
        new File(["one"], "one.png", { type: "image/png" }),
        new File(["two"], "two.jpg", { type: "image/jpeg" }),
      ],
      "chosen",
    );

    act(() => (byId("drop-0") as HTMLButtonElement).click());

    expect(byId("count").textContent).toBe("1");
    expect(byId("drop-0").textContent).toBe("two");
  });

  it("clearImages empties images and error together; dismissError keeps the images", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValue({
      images: [IMAGE_ONE],
      rejected: ["broken.png could not be read"],
    });
    mount();
    await pick([new File(["one"], "one.png", { type: "image/png" })], "mixed");
    expect(byId("count").textContent).toBe("1");
    expect(byId("error").textContent).toBe("broken.png could not be read");

    act(() => (byId("dismiss") as HTMLButtonElement).click());
    expect(byId("error").textContent).toBe("");
    expect(byId("count").textContent).toBe("1");

    act(() => (byId("clear") as HTMLButtonElement).click());
    expect(byId("count").textContent).toBe("0");
    expect(byId("error").textContent).toBe("");
  });
});
