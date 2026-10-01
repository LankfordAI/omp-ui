import { describe, expect, it } from "vitest";
import {
  hasClipboardDocument,
  hasClipboardImage,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  readClipboardDocuments,
  readClipboardImages,
  readDocumentFiles,
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
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 45, 46, 46]);

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

describe("hasClipboardDocument", () => {
  it("is true for a pdf item and false for an image or text", () => {
    expect(
      hasClipboardDocument(transfer([{ name: "a.pdf", type: "application/pdf", bytes: PDF_BYTES }])),
    ).toBe(true);
    expect(hasClipboardDocument(transfer([{ name: "a.png", type: "image/png", bytes: PNG }]))).toBe(
      false,
    );
    expect(hasClipboardDocument(textOnly)).toBe(false);
    expect(hasClipboardDocument(null)).toBe(false);
  });

  it("is true for an extension-only file the clipboard reports without a mime type", () => {
    expect(
      hasClipboardDocument(transfer([{ name: "from-manager.pdf", type: "", bytes: PDF_BYTES }])),
    ).toBe(true);
  });
});

describe("readDocumentFiles", () => {
  it("reads picker pdfs as bare base64 with the name carried, in order", async () => {
    const other = new Uint8Array([1, 2]);
    const files = transfer([
      { name: "spec.pdf", type: "application/pdf", bytes: PDF_BYTES },
      { name: "invoice.pdf", type: "application/pdf", bytes: other },
    ]).files;

    expect(await readDocumentFiles(files)).toEqual({
      documents: [
        { type: "document", name: "spec.pdf", data: b64(PDF_BYTES), mimeType: "application/pdf" },
        { type: "document", name: "invoice.pdf", data: b64(other), mimeType: "application/pdf" },
      ],
      rejected: [],
    });
  });

  it("skips non-pdfs silently, beside accepted ones", async () => {
    const files = transfer([
      { name: "photo.png", type: "image/png", bytes: PNG },
      { name: "spec.pdf", type: "application/pdf", bytes: PDF_BYTES },
    ]).files;

    const { documents, rejected } = await readDocumentFiles(files);
    expect(documents).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("accepts an extension-only file the file manager reports without a mime type", async () => {
    const { documents } = await readDocumentFiles(
      transfer([{ name: "from-manager.pdf", type: "", bytes: PDF_BYTES }]).files,
    );
    expect(documents[0]?.mimeType).toBe("application/pdf");
  });

  it("refuses a document over the 20 MB ceiling, naming it", async () => {
    const { documents, rejected } = await readDocumentFiles(
      transfer([
        { name: "huge.pdf", type: "application/pdf", bytes: PDF_BYTES, size: MAX_DOCUMENT_BYTES + 1 },
      ]).files,
    );
    expect(documents).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("huge.pdf");
    expect(rejected[0]).toContain("20 MB");
  });

  it("catches an oversize payload whose reported size lied", async () => {
    const { documents, rejected } = await readDocumentFiles([
      {
        name: "liar.pdf",
        type: "application/pdf",
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(MAX_DOCUMENT_BYTES + 1),
      } as unknown as File,
    ]);
    expect(documents).toEqual([]);
    expect(rejected[0]).toContain("liar.pdf");
  });

  it("sanitizes block-shaping characters out of the carried name", async () => {
    const { documents } = await readDocumentFiles(
      transfer([{ name: "a<b>.pdf", type: "application/pdf", bytes: PDF_BYTES }]).files,
    );
    expect(documents[0]?.name).toBe("ab.pdf");
  });
});

describe("readClipboardDocuments", () => {
  it("reads pdfs in clipboard order and ignores images and text", async () => {
    const { documents, rejected } = await readClipboardDocuments(
      transfer([
        { name: "a.png", type: "image/png", bytes: PNG },
        { name: "a.pdf", type: "application/pdf", bytes: PDF_BYTES },
      ]),
    );
    expect(rejected).toEqual([]);
    expect(documents).toEqual([
      { type: "document", name: "a.pdf", data: b64(PDF_BYTES), mimeType: "application/pdf" },
    ]);
    expect(await readClipboardDocuments(textOnly)).toEqual({ documents: [], rejected: [] });
    expect(await readClipboardDocuments(null)).toEqual({ documents: [], rejected: [] });
  });

  it("falls back to `files` when `items` yields nothing (drag-and-drop)", async () => {
    const { documents } = await readClipboardDocuments({
      items: [],
      files: [
        {
          name: "dropped.pdf",
          type: "application/pdf",
          size: PDF_BYTES.byteLength,
          arrayBuffer: async () => PDF_BYTES.buffer.slice(0, PDF_BYTES.byteLength),
        },
      ],
    } as unknown as DataTransfer);
    expect(documents).toHaveLength(1);
  });
});
