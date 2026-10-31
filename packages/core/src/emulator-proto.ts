/**
 * Hand-rolled protobuf subset for the Android emulator's gRPC
 * EmulatorController service (emulator_controller.proto). No protobuf
 * dependency: modelled on expo's serve-emu dependency-free client
 * (Apache-2.0). Only the fields omp-ui uses are encoded or decoded.
 */

const MAX_IMAGE_DIM = 16384;
const RGBA8888 = 1;
const NEVER_EXPIRE = 1;

class Writer {
  private bytes: number[] = [];

  /** Unsigned or signed varint; negatives become 10-byte two's complement. */
  varint(value: number): this {
    let v = BigInt.asUintN(64, BigInt(Math.trunc(value)));
    while (v >= 0x80n) {
      this.bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.bytes.push(Number(v));
    return this;
  }

  /** Varint field; proto3 default (0) is omitted. */
  uint(field: number, value: number): this {
    if (value === 0) return this;
    return this.varint(field << 3).varint(value);
  }

  bytesField(field: number, data: Uint8Array): this {
    this.varint((field << 3) | 2).varint(data.length);
    for (const b of data) this.bytes.push(b);
    return this;
  }

  string(field: number, text: string | undefined): this {
    if (!text) return this;
    return this.bytesField(field, new TextEncoder().encode(text));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export function encodeImageFormat(req: { width: number; height: number }): Uint8Array {
  return new Writer().uint(1, RGBA8888).uint(3, req.width).uint(4, req.height).finish();
}

interface Reader {
  buf: Uint8Array;
  pos: number;
}

function readVarint(r: Reader): number {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (r.pos >= r.buf.length || shift > 63n) throw new Error("truncated varint");
    const b = r.buf[r.pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return Number(BigInt.asUintN(64, result));
}

/** Walks fields; calls `on` with the varint value or the length-delimited payload. */
function forEachField(buf: Uint8Array, on: (field: number, value: number | Uint8Array) => void): void {
  const r: Reader = { buf, pos: 0 };
  while (r.pos < buf.length) {
    const tag = readVarint(r);
    const field = tag >>> 3;
    switch (tag & 7) {
      case 0:
        on(field, readVarint(r));
        break;
      case 1:
        r.pos += 8;
        break;
      case 2: {
        const len = readVarint(r);
        const end = r.pos + len;
        if (end > buf.length) throw new Error("truncated field");
        on(field, buf.subarray(r.pos, end));
        r.pos = end;
        break;
      }
      case 5:
        r.pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${tag & 7}`);
    }
    if (r.pos > buf.length) throw new Error("truncated field");
  }
}

export function decodeImage(
  buf: Uint8Array,
): { width: number; height: number; seq: number; pixels: Uint8Array } | null {
  let width = 0;
  let height = 0;
  let seq = 0;
  let pixels: Uint8Array = new Uint8Array(0);
  forEachField(buf, (field, value) => {
    if (field === 1 && value instanceof Uint8Array) {
      forEachField(value, (f, v) => {
        if (f === 3 && typeof v === "number") width = v;
        else if (f === 4 && typeof v === "number") height = v;
      });
    } else if (field === 4 && value instanceof Uint8Array) pixels = value;
    else if (field === 5 && typeof value === "number") seq = value;
  });
  if (pixels.length === 0) return null;
  if (width <= 0 || height <= 0 || width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
    throw new Error(`image size out of range: ${width}x${height}`);
  }
  if (pixels.length !== width * height * 4) {
    throw new Error(`image byte length ${pixels.length} != ${width}x${height}x4`);
  }
  return { width, height, seq, pixels };
}

export function encodeTouchInput(
  touches: Array<{ x: number; y: number; id: number; pressure: number }>,
): Uint8Array {
  const event = new Writer();
  for (const t of touches) {
    const touch = new Writer().uint(1, t.x).uint(2, t.y).uint(3, t.id).uint(4, t.pressure).uint(7, NEVER_EXPIRE);
    event.bytesField(1, touch.finish());
  }
  return new Writer().bytesField(2, event.finish()).finish();
}

export function encodeMouseInput(x: number, y: number, buttons: number): Uint8Array {
  return new Writer().bytesField(3, new Writer().uint(1, x).uint(2, y).uint(3, buttons).finish()).finish();
}

export function encodeWheelInput(dx: number, dy: number): Uint8Array {
  return new Writer().bytesField(6, new Writer().uint(1, dx).uint(2, dy).finish()).finish();
}

export function encodeKeyInput(ev: { eventType: 0 | 1 | 2; key?: string; text?: string }): Uint8Array {
  const key = new Writer().uint(2, ev.eventType).string(4, ev.key).string(5, ev.text).finish();
  return new Writer().bytesField(1, key).finish();
}

export function encodeClipData(text: string): Uint8Array {
  return new Writer().string(1, text).finish();
}

export function encodeVmRunState(state: number): Uint8Array {
  return new Writer().uint(1, state).finish();
}

/** gRPC length-prefix: 0x00 flag + u32 BE length. */
export function grpcFrame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length);
  out.set(message, 5);
  return out;
}

/**
 * Incremental 5-byte-prefix reassembler. `push` throws on a compressed frame
 * or a frame over maxBytes; the parser is unusable afterward.
 */
export class GrpcMessageParser {
  private pending = new Uint8Array(0);
  private failed: Error | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly onMessage: (m: Uint8Array) => void,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.failed) throw this.failed;
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending);
    merged.set(chunk, this.pending.length);
    let pos = 0;
    while (merged.length - pos >= 5) {
      if (merged[pos] !== 0) this.fail("compressed gRPC frames are not supported");
      const len = new DataView(merged.buffer, merged.byteOffset + pos + 1, 4).getUint32(0);
      if (len > this.maxBytes) this.fail(`gRPC frame of ${len} bytes exceeds ${this.maxBytes}`);
      if (merged.length - pos - 5 < len) break;
      this.onMessage(merged.subarray(pos + 5, pos + 5 + len));
      pos += 5 + len;
    }
    this.pending = merged.slice(pos);
  }

  private fail(message: string): never {
    this.failed = new Error(message);
    this.pending = new Uint8Array(0);
    throw this.failed;
  }
}
