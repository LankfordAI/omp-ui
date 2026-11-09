/**
 * Hand-rolled protobuf subset for the Android emulator's gRPC
 * EmulatorController service (emulator_controller.proto). No protobuf
 * dependency: modelled on expo's serve-emu dependency-free client
 * (Apache-2.0). Only the fields omp-ui uses are encoded or decoded.
 */

const MAX_IMAGE_DIM = 16384;
const RGBA8888 = 1;
const NEVER_EXPIRE = 1;
const MAX_PARAMETER_VALUES = 64;
const MAX_DISPLAYS = 64;

export interface EmulatorPhysicalModel {
  target: number;
  status: number;
  values: number[];
}

export interface EmulatorDisplayConfiguration {
  display: number;
  width: number;
  height: number;
  dpi: number;
  flags: number;
}

export type EmulatorNotification =
  | { type: "posture"; posture: number }
  | { type: "display-configurations"; displays: EmulatorDisplayConfiguration[] }
  | { type: "display-power"; display: number; powerMode: number }
  | { type: "unknown" };

export interface EmulatorImage {
  width: number;
  height: number;
  seq: number;
  pixels: Uint8Array;
  rotation: 0 | 1 | 2 | 3;
  display: number;
  foldedDisplay: { width: number; height: number; xOffset: number; yOffset: number } | null;
  displayMode: number | null;
  timestampUs: number;
}

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

export function encodeImageFormat(req: { width: number; height: number; display?: number }): Uint8Array {
  return new Writer().uint(1, RGBA8888).uint(3, req.width).uint(4, req.height).uint(5, req.display ?? 0).finish();
}

interface Reader {
  buf: Uint8Array;
  pos: number;
}

function readVarint(r: Reader): bigint {
  let result = 0n;
  for (let shift = 0n; shift <= 63n; shift += 7n) {
    if (r.pos >= r.buf.length) throw new Error("truncated varint");
    const b = r.buf[r.pos++];
    if (shift === 63n && b > 1) throw new Error("varint exceeds 64 bits");
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result;
  }
  throw new Error("varint exceeds 64 bits");
}

function readTag(r: Reader): number {
  const tag = readVarint(r);
  if (tag > 0xffffffffn || tag < 8n) throw new Error("invalid protobuf tag");
  return Number(tag);
}

function takeBytes(r: Reader, length: number): Uint8Array {
  if (length > r.buf.length - r.pos) throw new Error("truncated field");
  const start = r.pos;
  r.pos += length;
  return r.buf.subarray(start, r.pos);
}

function skipGroup(r: Reader, field: number, depth = 0): void {
  if (depth >= 64) throw new Error("protobuf group nesting exceeds 64");
  while (r.pos < r.buf.length) {
    const tag = readTag(r);
    const child = tag >>> 3;
    const wire = tag & 7;
    if (wire === 4) {
      if (child !== field) throw new Error("mismatched protobuf group");
      return;
    }
    readField(r, child, wire, depth + 1);
  }
  throw new Error("truncated protobuf group");
}

function readField(r: Reader, field: number, wire: number, depth = 0): number | Uint8Array | null {
  switch (wire) {
    case 0:
      return Number(BigInt.asIntN(64, readVarint(r)));
    case 1:
      return takeBytes(r, 8);
    case 2: {
      const length = readVarint(r);
      if (length > BigInt(r.buf.length - r.pos)) throw new Error("truncated field");
      return takeBytes(r, Number(length));
    }
    case 3:
      skipGroup(r, field, depth);
      return null;
    case 5:
      return takeBytes(r, 4);
    default:
      throw new Error(`unsupported wire type ${wire}`);
  }
}

/** Unknown fields, including deprecated groups, are skipped without interpreting their contents. */
function forEachField(
  buf: Uint8Array,
  on: (field: number, value: number | Uint8Array, wire: number) => void,
): void {
  const r: Reader = { buf, pos: 0 };
  while (r.pos < buf.length) {
    const tag = readTag(r);
    const field = tag >>> 3;
    const wire = tag & 7;
    const value = readField(r, field, wire);
    if (value !== null) on(field, value, wire);
  }
}

function uint(value: number | Uint8Array, wire: number, max = 0xffffffff): number {
  if (wire !== 0 || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error("invalid unsigned protobuf value");
  }
  return value;
}

function message(value: number | Uint8Array, wire: number): Uint8Array {
  if (wire !== 2 || !(value instanceof Uint8Array)) throw new Error("invalid protobuf message");
  return value;
}

function imageDimension(value: number): number {
  if (value <= 0 || value > MAX_IMAGE_DIM) throw new Error(`image size out of range: ${value}`);
  return value;
}

export function encodePhysicalModel(target: number, values?: readonly number[]): Uint8Array {
  uint(target, 0);
  const model = new Writer().uint(1, target);
  if (values !== undefined) {
    if (values.length > MAX_PARAMETER_VALUES) throw new Error("too many physical model values");
    const packed = new Uint8Array(values.length * 4);
    const view = new DataView(packed.buffer);
    for (let i = 0; i < values.length; i++) {
      view.setFloat32(i * 4, values[i], true);
      if (!Number.isFinite(values[i]) || !Number.isFinite(view.getFloat32(i * 4, true))) {
        throw new Error("physical model values must be finite float32");
      }
    }
    model.bytesField(3, new Writer().bytesField(1, packed).finish());
  }
  return model.finish();
}

export function decodePhysicalModel(raw: Uint8Array): EmulatorPhysicalModel {
  const model: EmulatorPhysicalModel = { target: 0, status: 0, values: [] };
  forEachField(raw, (field, value, wire) => {
    if (field === 1) model.target = uint(value, wire);
    else if (field === 2) {
      if (wire !== 0 || typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
        throw new Error("invalid physical model status");
      }
      model.status = value;
    } else if (field === 3) {
      forEachField(message(value, wire), (parameter, data, parameterWire) => {
        if (parameter !== 1) return;
        if (!(data instanceof Uint8Array) || (parameterWire !== 2 && parameterWire !== 5) || data.length % 4 !== 0) {
          throw new Error("invalid physical model float data");
        }
        if (model.values.length + data.length / 4 > MAX_PARAMETER_VALUES) throw new Error("too many physical model values");
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let offset = 0; offset < data.length; offset += 4) {
          const item = view.getFloat32(offset, true);
          if (!Number.isFinite(item)) throw new Error("physical model values must be finite");
          model.values.push(item);
        }
      });
    }
  });
  return model;
}

export function decodeDisplayConfigurations(raw: Uint8Array): EmulatorDisplayConfiguration[] {
  const displays: EmulatorDisplayConfiguration[] = [];
  forEachField(raw, (field, value, wire) => {
    if (field !== 1) return;
    if (displays.length >= MAX_DISPLAYS) throw new Error("too many display configurations");
    const display: EmulatorDisplayConfiguration = { display: 0, width: 0, height: 0, dpi: 0, flags: 0 };
    forEachField(message(value, wire), (f, v, w) => {
      if (f === 1) display.width = uint(v, w);
      else if (f === 2) display.height = uint(v, w);
      else if (f === 3) display.dpi = uint(v, w);
      else if (f === 4) display.flags = uint(v, w);
      else if (f === 5) display.display = uint(v, w);
    });
    imageDimension(display.width);
    imageDimension(display.height);
    displays.push(display);
  });
  return displays;
}

export function decodeEmulatorNotification(raw: Uint8Array): EmulatorNotification {
  let notification: EmulatorNotification = { type: "unknown" };
  forEachField(raw, (field, value, wire) => {
    if (field === 3) {
      let displays: EmulatorDisplayConfiguration[] = [];
      forEachField(message(value, wire), (f, v, w) => {
        if (f === 1) displays = decodeDisplayConfigurations(message(v, w));
      });
      notification = { type: "display-configurations", displays };
    } else if (field === 4) {
      let posture = 0;
      forEachField(message(value, wire), (f, v, w) => {
        if (f === 3) posture = uint(v, w);
      });
      notification = { type: "posture", posture };
    } else if (field === 11) {
      let display = 0;
      let powerMode = 0;
      forEachField(message(value, wire), (f, v, w) => {
        if (f === 1) display = uint(v, w);
        else if (f === 2) powerMode = uint(v, w);
      });
      notification = { type: "display-power", display, powerMode };
    } else if (field >= 2 && field <= 10) {
      notification = { type: "unknown" };
    }
  });
  return notification;
}

export function decodeImage(buf: Uint8Array): EmulatorImage | null {
  const image: EmulatorImage = {
    width: 0,
    height: 0,
    seq: 0,
    pixels: new Uint8Array(0),
    rotation: 0,
    display: 0,
    foldedDisplay: null,
    displayMode: null,
    timestampUs: 0,
  };
  forEachField(buf, (field, value, wire) => {
    if (field === 1) {
      forEachField(message(value, wire), (f, v, w) => {
        if (f === 2) {
          forEachField(message(v, w), (rotationField, rotationValue, rotationWire) => {
            if (rotationField === 1) image.rotation = uint(rotationValue, rotationWire, 3) as 0 | 1 | 2 | 3;
          });
        } else if (f === 3) image.width = uint(v, w);
        else if (f === 4) image.height = uint(v, w);
        else if (f === 5) image.display = uint(v, w);
        else if (f === 7) {
          const folded = { width: 0, height: 0, xOffset: 0, yOffset: 0 };
          forEachField(message(v, w), (ff, fv, fw) => {
            if (ff === 1) folded.width = uint(fv, fw);
            else if (ff === 2) folded.height = uint(fv, fw);
            else if (ff === 3) folded.xOffset = uint(fv, fw);
            else if (ff === 4) folded.yOffset = uint(fv, fw);
          });
          imageDimension(folded.width);
          imageDimension(folded.height);
          if (folded.xOffset + folded.width > MAX_IMAGE_DIM || folded.yOffset + folded.height > MAX_IMAGE_DIM) {
            throw new Error("folded display region out of range");
          }
          image.foldedDisplay = folded;
        } else if (f === 8) image.displayMode = uint(v, w);
      });
    } else if (field === 4) image.pixels = message(value, wire);
    else if (field === 5) image.seq = uint(value, wire);
    else if (field === 6) image.timestampUs = uint(value, wire, Number.MAX_SAFE_INTEGER);
  });
  if (image.pixels.length === 0) return null;
  imageDimension(image.width);
  imageDimension(image.height);
  if (image.pixels.length !== image.width * image.height * 4) {
    throw new Error(`image byte length ${image.pixels.length} != ${image.width}x${image.height}x4`);
  }
  return image;
}

export function encodeTouchInput(
  touches: Array<{ x: number; y: number; id: number; pressure: number }>,
  display = 0,
): Uint8Array {
  const event = new Writer();
  for (const t of touches) {
    const touch = new Writer().uint(1, t.x).uint(2, t.y).uint(3, t.id).uint(4, t.pressure).uint(7, NEVER_EXPIRE);
    event.bytesField(1, touch.finish());
  }
  return new Writer().bytesField(2, event.uint(2, display).finish()).finish();
}

export function encodeMouseInput(x: number, y: number, buttons: number, display = 0): Uint8Array {
  const event = new Writer().uint(1, x).uint(2, y).uint(3, buttons).uint(4, display).finish();
  return new Writer().bytesField(3, event).finish();
}

export function encodeWheelInput(dx: number, dy: number, display = 0): Uint8Array {
  return new Writer().bytesField(6, new Writer().uint(1, dx).uint(2, dy).uint(3, display).finish()).finish();
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
  /** Unconsumed bytes are chunks[0].subarray(head) followed by chunks[1..]. */
  private chunks: Uint8Array[] = [];
  private head = 0;
  private total = 0;
  private failed: Error | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly onMessage: (m: Uint8Array) => void,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.failed) throw this.failed;
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total >= 5) {
      if (this.peekByte(0) !== 0) this.fail("compressed gRPC frames are not supported");
      const len =
        (this.peekByte(1) * 0x1000000 + (this.peekByte(2) << 16) + (this.peekByte(3) << 8) + this.peekByte(4)) >>> 0;
      if (len > this.maxBytes) this.fail(`gRPC frame of ${len} bytes exceeds ${this.maxBytes}`);
      if (this.total - 5 < len) break;
      this.skip(5);
      this.onMessage(this.take(len));
    }
  }

  /** Verify that a completed response did not end midway through a frame. */
  end(): void {
    if (this.failed) throw this.failed;
    if (this.total !== 0) this.fail("truncated gRPC frame");
  }

  private peekByte(i: number): number {
    let off = this.head + i;
    for (const c of this.chunks) {
      if (off < c.length) return c[off];
      off -= c.length;
    }
    throw new Error("unreachable: peek past buffered bytes");
  }

  private skip(n: number): void {
    this.total -= n;
    while (n > 0) {
      const avail = this.chunks[0].length - this.head;
      if (n < avail) {
        this.head += n;
        return;
      }
      n -= avail;
      this.chunks.shift();
      this.head = 0;
    }
  }

  /** Consume n bytes; zero-copy when they lie in one chunk, else one allocation. */
  private take(n: number): Uint8Array {
    const first = this.chunks[0];
    if (n === 0) return new Uint8Array(0);
    if (first.length - this.head >= n) {
      const out = first.subarray(this.head, this.head + n);
      this.skip(n);
      return out;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0];
      const part = Math.min(c.length - this.head, n - filled);
      out.set(c.subarray(this.head, this.head + part), filled);
      filled += part;
      this.skip(part);
    }
    return out;
  }

  private fail(message: string): never {
    this.failed = new Error(message);
    this.chunks = [];
    this.head = 0;
    this.total = 0;
    throw this.failed;
  }
}
