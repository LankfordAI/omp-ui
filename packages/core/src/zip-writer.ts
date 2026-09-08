import { crc32, deflateRaw } from "node:zlib";
import { promisify } from "node:util";

const deflateRawP = promisify(deflateRaw);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_MADE_BY = 0x0014; // PKZIP 2.0, DOS compatibility byte 00
const VERSION_NEEDED = 20; // 2.0 — deflate
const FLAG_UTF8 = 0x0800; // general-purpose bit 11: names are UTF-8
const METHOD_DEFLATE = 8;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const MAX_ENTRIES = 0xfffe; // beyond this the 16-bit counts lie (no zip64)
const MAX_U32 = 0xffffffff; // neither size side may reach the zip64 sentinel

export interface ZipEntryInput {
  /** Forward-slash relative path, e.g. "logs/main.log". */
  name: string;
  data: Uint8Array;
}

interface EncodedEntry {
  nameBytes: Uint8Array;
  crc: number;
  compressed: Uint8Array;
  uncompressed: number;
}

function assertSafeName(name: string, index: number): void {
  const unsafe =
    name === "" ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((segment) => segment === "" || segment === "..");
  if (unsafe) {
    throw new Error(`zip entry ${index} has an unsafe name: ${JSON.stringify(name)}`);
  }
}

/** MS-DOS timestamp fields (1980-based), as zip headers store them. */
function dosFields(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds a whole-archive zip in memory: one deflateRaw pass per entry, CRC-32
 * from `zlib.crc32`, UTF-8 name flag set, version 2.0 on both sides. The
 * layout is fixed — 30-byte local headers, 46-byte central entries, a 22-byte
 * EOCD — and carries no zip64 records, so entry counts and either size side
 * beyond the 16-bit/32-bit fields throw `RangeError` instead of corrupting
 * the archive. Callers bound the payload well below 4 GiB.
 */
export async function buildZip(
  entries: readonly ZipEntryInput[],
  now: Date = new Date(),
): Promise<Uint8Array> {
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError(`zip supports at most ${MAX_ENTRIES} entries, got ${entries.length}`);
  }
  const { time, date } = dosFields(now);

  // Pass 1: deflate every entry and compute its CRC before sizing the buffer,
  // so the whole archive is one allocation with no growth copies.
  const encoded: EncodedEntry[] = [];
  let dataBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    assertSafeName(entry.name, index);
    const raw = entry.data;
    if (raw.length > MAX_U32 - 1) {
      throw new RangeError(`zip entry ${index} exceeds the 4 GiB field limit`);
    }
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = await deflateRawP(raw.length === 0 ? new Uint8Array(0) : raw);
    if (compressed.length > MAX_U32 - 1) {
      throw new RangeError(`zip entry ${index} compressed size exceeds the field limit`);
    }
    dataBytes += LOCAL_HEADER_BYTES + nameBytes.length + compressed.length;
    encoded.push({ nameBytes, crc: crc32(raw), compressed, uncompressed: raw.length });
  }

  const centralBytes = encoded.reduce(
    (sum, entry) => sum + CENTRAL_HEADER_BYTES + entry.nameBytes.length,
    0,
  );
  if (dataBytes > MAX_U32 || centralBytes > MAX_U32 - dataBytes) {
    throw new RangeError("zip archive exceeds the 4 GiB field limit");
  }

  const buffer = Buffer.alloc(dataBytes + centralBytes + EOCD_BYTES);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const writeU32 = (at: number, value: number): void => view.setUint32(at, value, true);
  const writeU16 = (at: number, value: number): void => view.setUint16(at, value, true);

  // Shared fields (sig + both version words excluded: the two headers store
  // them at different offsets). Writes crc/method/times/sizes given a base.
  const localOffsets: number[] = [];
  let offset = 0;
  for (const entry of encoded) {
    localOffsets.push(offset);
    writeU32(offset, LOCAL_SIG);
    writeU16(offset + 4, VERSION_NEEDED);
    writeU16(offset + 6, FLAG_UTF8);
    writeU16(offset + 8, METHOD_DEFLATE);
    writeU16(offset + 10, time);
    writeU16(offset + 12, date);
    writeU32(offset + 14, entry.crc);
    writeU32(offset + 18, entry.compressed.length);
    writeU32(offset + 22, entry.uncompressed);
    writeU16(offset + 26, entry.nameBytes.length);
    writeU16(offset + 28, 0); // no extra field
    buffer.set(entry.nameBytes, offset + LOCAL_HEADER_BYTES);
    buffer.set(entry.compressed, offset + LOCAL_HEADER_BYTES + entry.nameBytes.length);
    offset += LOCAL_HEADER_BYTES + entry.nameBytes.length + entry.compressed.length;
  }

  const centralStart = offset;
  for (let index = 0; index < encoded.length; index += 1) {
    const entry = encoded[index]!;
    writeU32(offset, CENTRAL_SIG);
    writeU16(offset + 4, VERSION_MADE_BY);
    writeU16(offset + 6, VERSION_NEEDED);
    writeU16(offset + 8, FLAG_UTF8);
    writeU16(offset + 10, METHOD_DEFLATE);
    writeU16(offset + 12, time);
    writeU16(offset + 14, date);
    writeU32(offset + 16, entry.crc);
    writeU32(offset + 20, entry.compressed.length);
    writeU32(offset + 24, entry.uncompressed);
    writeU16(offset + 28, entry.nameBytes.length);
    // extra (30), comment (32), disk (34), internal (36) and external (38–41)
    // attributes: all zero — the buffer starts zeroed.
    writeU32(offset + 42, localOffsets[index]!);
    buffer.set(entry.nameBytes, offset + CENTRAL_HEADER_BYTES);
    offset += CENTRAL_HEADER_BYTES + entry.nameBytes.length;
  }

  writeU32(offset, EOCD_SIG);
  writeU16(offset + 8, encoded.length);
  writeU16(offset + 10, encoded.length);
  writeU32(offset + 12, offset - centralStart);
  writeU32(offset + 16, centralStart);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
