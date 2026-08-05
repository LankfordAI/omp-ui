import { describe, expect, it } from "vitest";
import {
  hasClipboardImage,
  MAX_IMAGE_BYTES,
  readClipboardImages,
  readImageFiles,
} from "./clipboard-image";

/**
 * A DataTransfer stand-in. jsdom's own is not wired up for synthetic paste
 * events, and the reader only ever touches `items` and `files`.
 */
function transfer(entries: { name: string; type: string; bytes: Uint8Array; size?: number }[]) {
  const files = entries.map((e) => {
    const file = {
      name: e.name,
      type: e.type,
      size: e.size ?? e.bytes.byteLength,
      arrayBuffer: async () =>
        e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength),
    };
    return file as unknown as File;
  });
  return {
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
  } as unknown as DataTransfer;
}

/** A text-only clipboard: an item of kind "string", no files. */
const textOnly = {
  items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
  files: [],
} as unknown as DataTransfer;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** Independent base64 reference, so the expectation is not the code under test. */
function b64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

describe("hasClipboardImage", () => {
  it("is true for an image item and false for text", () => {
    expect(hasClipboardImage(transfer([{ name: "a.png", type: "image/png", bytes: PNG }]))).toBe(
      true,
    );
    expect(hasClipboardImage(textOnly)).toBe(false);
    expect(hasClipboardImage(null)).toBe(false);
  });
});

describe("readImageFiles", () => {
  it("reads multiple picker files as bare base64 in selection order", async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const files = transfer([
      { name: "first.png", type: "image/png", bytes: first },
      { name: "second.webp", type: "image/webp", bytes: second },
    ]).files;

    expect(await readImageFiles(files)).toEqual({
      images: [
        { type: "image", data: b64(first), mimeType: "image/png" },
        { type: "image", data: b64(second), mimeType: "image/webp" },
      ],
      rejected: [],
    });
  });

  it("excludes picker files with non-image MIME types", async () => {
    const files = transfer([
      { name: "notes.txt", type: "text/plain", bytes: new Uint8Array([1]) },
      { name: "photo.png", type: "image/png", bytes: PNG },
    ]).files;

    const { images, rejected } = await readImageFiles(files);
    expect(images).toEqual([{ type: "image", data: b64(PNG), mimeType: "image/png" }]);
    expect(rejected).toEqual([]);
  });

  it("uses the image fallback MIME when the picker reports no type", async () => {
    const files = transfer([{ name: "photo", type: "", bytes: PNG }]).files;

    const { images } = await readImageFiles(files);
    expect(images).toEqual([{ type: "image", data: b64(PNG), mimeType: "image/png" }]);
  });

  it("rejects picker files over the limit before and after reading", async () => {
    let precheckedRead = false;
    const reportedOversize = {
      name: "reported.png",
      type: "image/png",
      size: MAX_IMAGE_BYTES + 1,
      arrayBuffer: async () => {
        precheckedRead = true;
        return PNG.buffer.slice(0, PNG.byteLength);
      },
    } as unknown as File;
    const actualOversize = {
      name: "actual.png",
      type: "image/png",
      size: PNG.byteLength,
      arrayBuffer: async () => new ArrayBuffer(MAX_IMAGE_BYTES + 1),
    } as unknown as File;

    const { images, rejected } = await readImageFiles([reportedOversize, actualOversize]);
    expect(precheckedRead).toBe(false);
    expect(images).toEqual([]);
    expect(rejected).toEqual([
      "reported.png is 20.0 MB — over omp's 20 MB image limit",
      "actual.png is 20.0 MB — over omp's 20 MB image limit",
    ]);
  });

  it("reports an unreadable picker file and continues in order", async () => {
    const unreadable = {
      name: "unreadable.png",
      type: "image/png",
      size: PNG.byteLength,
      arrayBuffer: async () => {
        throw new Error("not readable");
      },
    } as unknown as File;
    const readable = transfer([{ name: "readable.png", type: "image/png", bytes: PNG }]).files[0];

    const { images, rejected } = await readImageFiles([unreadable, readable]);
    expect(images).toEqual([{ type: "image", data: b64(PNG), mimeType: "image/png" }]);
    expect(rejected).toEqual(["could not read unreadable.png"]);
  });
});

describe("readClipboardImages", () => {
  it("reads images as bare base64, in clipboard order", async () => {
    const other = new Uint8Array([9, 9]);
    const { images, rejected } = await readClipboardImages(
      transfer([
        { name: "a.png", type: "image/png", bytes: PNG },
        { name: "b.webp", type: "image/webp", bytes: other },
      ]),
    );
    expect(rejected).toEqual([]);
    expect(images).toEqual([
      // No `data:` prefix — omp feeds `data` straight to Buffer.from(_, "base64").
      { type: "image", data: b64(PNG), mimeType: "image/png" },
      { type: "image", data: b64(other), mimeType: "image/webp" },
    ]);
  });

  it("ignores a text-only paste entirely", async () => {
    expect(await readClipboardImages(textOnly)).toEqual({ images: [], rejected: [] });
    expect(await readClipboardImages(null)).toEqual({ images: [], rejected: [] });
  });

  it("claims png when the clipboard reports no mime type", async () => {
    // Chromium can hand over an item with an empty `type`; omp converts unknown
    // formats to png anyway, so png is the useful guess.
    const { images } = await readClipboardImages({
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => ({
            name: "x",
            type: "",
            size: PNG.byteLength,
            arrayBuffer: async () => PNG.buffer.slice(0, PNG.byteLength),
          }),
        },
      ],
      files: [],
    } as unknown as DataTransfer);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  it("refuses an image over omp's 20 MB input ceiling, naming it", async () => {
    // omp does NOT enforce this on the rpc `images` field, so the refusal has
    // to happen here or a huge paste becomes a huge JSON line on omp's stdin.
    const { images, rejected } = await readClipboardImages(
      transfer([{ name: "huge.png", type: "image/png", bytes: PNG, size: MAX_IMAGE_BYTES + 1 }]),
    );
    expect(images).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("huge.png");
    expect(rejected[0]).toContain("20 MB");
  });

  it("catches an oversize payload whose reported size lied", async () => {
    // `size` is advisory for some virtual clipboard files, so the post-read
    // check is the one that actually holds.
    const big = new Uint8Array(64);
    const { images, rejected } = await readClipboardImages({
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => ({
            name: "liar.png",
            type: "image/png",
            size: 10,
            arrayBuffer: async () => new ArrayBuffer(MAX_IMAGE_BYTES + 1),
          }),
        },
      ],
      files: [],
    } as unknown as DataTransfer);
    expect(big.byteLength).toBe(64); // keeps the fixture honest
    expect(images).toEqual([]);
    expect(rejected[0]).toContain("liar.png");
  });

  it("keeps the readable images when one of them fails", async () => {
    const { images, rejected } = await readClipboardImages({
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => ({
            name: "bad.png",
            type: "image/png",
            size: 4,
            arrayBuffer: async () => {
              throw new Error("gone");
            },
          }),
        },
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => ({
            name: "good.png",
            type: "image/png",
            size: PNG.byteLength,
            arrayBuffer: async () => PNG.buffer.slice(0, PNG.byteLength),
          }),
        },
      ],
      files: [],
    } as unknown as DataTransfer);
    expect(images).toHaveLength(1);
    expect(rejected[0]).toContain("bad.png");
  });

  it("falls back to `files` when `items` yields nothing (drag-and-drop)", async () => {
    const { images } = await readClipboardImages({
      items: [],
      files: [
        {
          name: "dropped.png",
          type: "image/png",
          size: PNG.byteLength,
          arrayBuffer: async () => PNG.buffer.slice(0, PNG.byteLength),
        },
      ],
    } as unknown as DataTransfer);
    expect(images).toHaveLength(1);
  });
});
