import { crc32, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildZip, type ZipEntryInput } from "./zip-writer";

const inflateRawP = promisify(inflateRaw);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface ParsedEntry {
  name: string;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Walks the central directory from the EOCD, exactly as a reader would. */
function parse(zip: Uint8Array): ParsedEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(EOCD_SIG);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  expect(view.getUint16(eocd + 20, true)).toBe(0);
  expect(centralOffset + centralSize).toBe(eocd);

  const entries: ParsedEntry[] = [];
  let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(CENTRAL_SIG);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)),
      flags: view.getUint16(at + 8, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function bytesOf(zip: Uint8Array, entry: ParsedEntry): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.localOffset;
  expect(view.getUint32(at, true)).toBe(LOCAL_SIG);
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  if (entry.uncompressedSize === 0) return new Uint8Array(0);
  return new Uint8Array(await inflateRawP(zip.subarray(start, start + entry.compressedSize)));
}

const FIXED = new Date(2026, 8, 8, 13, 45, 30);

describe("buildZip", () => {
  it("round-trips entries with valid CRCs, UTF-8 names, and local offsets", async () => {
    const inputs: ZipEntryInput[] = [
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify({ a: 1 })) },
      { name: "logs/breadcrumbs.log", data: new TextEncoder().encode("x".repeat(5000)) },
      { name: "git/0-ünicode.txt", data: new TextEncoder().encode("한글 내용") },
    ];
    const zip = await buildZip(inputs, FIXED);
    const entries = parse(zip);
    expect(entries.map((e) => e.name)).toEqual(inputs.map((e) => e.name));
    for (const [index, entry] of entries.entries()) {
      expect(entry.flags & 0x0800, "UTF-8 flag").not.toBe(0);
      expect(await bytesOf(zip, entry)).toEqual(inputs[index]!.data);
      expect(entry.crc).toBe(crc32(inputs[index]!.data));
      expect(entry.uncompressedSize).toBe(inputs[index]!.data.length);
    }
    // Local offsets are strictly increasing and address real local headers.
    expect(entries[1]!.localOffset).toBeGreaterThan(entries[0]!.localOffset);
  });

  it("builds a structurally valid empty archive", async () => {
    const zip = await buildZip([], FIXED);
    expect(zip).toHaveLength(22);
    expect(parse(zip)).toEqual([]);
  });

  it("stores an empty entry without deflated bytes", async () => {
    const zip = await buildZip([{ name: "empty.txt", data: new Uint8Array(0) }], FIXED);
    const [entry] = parse(zip);
    expect(entry!.uncompressedSize).toBe(0);
    expect(await bytesOf(zip, entry!)).toEqual(new Uint8Array(0));
  });

  it("derives dos timestamps deterministically from the injected date", async () => {
    const zip = await buildZip([{ name: "a.txt", data: new TextEncoder().encode("a") }], FIXED);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const expectedTime = (13 << 11) | (45 << 5) | (30 >> 1);
    const expectedDate = ((2026 - 1980) << 9) | (9 << 5) | 8;
    const [entry] = parse(zip);
    // Local header time/date fields.
    expect(view.getUint16(entry!.localOffset + 10, true)).toBe(expectedTime);
    expect(view.getUint16(entry!.localOffset + 12, true)).toBe(expectedDate);
    // Central directory time/date fields.
    const centralBase = zip.length - 22 - (46 + "a.txt".length);
    expect(view.getUint32(centralBase, true)).toBe(CENTRAL_SIG);
    expect(view.getUint16(centralBase + 12, true)).toBe(expectedTime);
    expect(view.getUint16(centralBase + 14, true)).toBe(expectedDate);
  });

  it("refuses archives past the 16-bit entry count", async () => {
    const entries = Array.from({ length: 65_535 }, (_, i) => ({
      name: `e${i}.txt`,
      data: new Uint8Array(0),
    }));
    await expect(buildZip(entries, FIXED)).rejects.toThrow(RangeError);
  });

  it.each([
    "/escape.txt",
    "../escape.txt",
    "a/../b.txt",
    "C:/escape.txt",
    "back\\slash.txt",
    "double//slash.txt",
    "",
  ])("rejects unsafe entry name %j", async (name) => {
    await expect(buildZip([{ name, data: new Uint8Array(0) }], FIXED)).rejects.toThrow(
      /unsafe name/,
    );
  });
});
