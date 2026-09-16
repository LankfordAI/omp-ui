/**
 * The remote transport's wire format (issue #37). Pure and dependency-free: the browser client
 * imports this exact module, so nothing here may reach for `node:` or Electron.
 */

/** JSON frames. Binary event payloads use encodeBinaryEvent below instead. */
export type ClientFrame =
  | { t: "req"; id: number; ch: string; args: unknown[] }
  | { t: "notify"; ch: string; args: unknown[] };

/**
 * The one narrowing for inbound JSON frames (issue #301). A well-formed frame comes back
 * with `args` normalized to an array — a missing `args` dispatches with no arguments, as
 * the server did before. Anything else (non-object, missing `ch`, a non-numeric `id` on a
 * req, a present-but-non-array `args`) is null: dropped, never thrown.
 */
export function parseClientFrame(frame: unknown): ClientFrame | null {
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as { t?: unknown; id?: unknown; ch?: unknown; args?: unknown };
  if (typeof f.ch !== "string") return null;
  if (f.args !== undefined && !Array.isArray(f.args)) return null;
  const args = f.args ?? [];
  if (f.t === "notify") return { t: "notify", ch: f.ch, args };
  if (f.t === "req" && typeof f.id === "number") return { t: "req", id: f.id, ch: f.ch, args };
  return null;
}

export type ServerFrame =
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; message: string }
  | { t: "ev"; ch: string; args: unknown[] }
  | { t: "frames"; key: string };

/**
 * The one narrowing for inbound server frames — mirror of parseClientFrame's
 * posture: normalize, return null, never throw. The browser client's hand-
 * written field checks used to be a second copy of this grammar.
 */
export function parseServerFrame(frame: unknown): ServerFrame | null {
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as {
    t?: unknown;
    id?: unknown;
    ch?: unknown;
    ok?: unknown;
    value?: unknown;
    message?: unknown;
    args?: unknown;
    key?: unknown;
  };
  if (f.t === "frames") {
    return typeof f.key === "string" && /^[0-9a-f]{64}$/.test(f.key)
      ? { t: "frames", key: f.key }
      : null;
  }
  if (f.t === "ev" && typeof f.ch === "string") {
    return { t: "ev", ch: f.ch, args: Array.isArray(f.args) ? f.args : [] };
  }
  if (f.t !== "res" || typeof f.id !== "number") return null;
  if (f.ok === true) return { t: "res", id: f.id, ok: true, value: f.value };
  return {
    t: "res",
    id: f.id,
    ok: false,
    message: typeof f.message === "string" ? f.message : "remote call failed",
  };
}

/** The one builders set — every send site composes through these, so wire drift fails typecheck in this file alone. */
export function makeClientRequestFrame(id: number, ch: string, args: unknown[]): ClientFrame {
  return { t: "req", id, ch, args };
}

export function makeClientNotifyFrame(ch: string, args: unknown[]): ClientFrame {
  return { t: "notify", ch, args };
}

export function makeServerResponseOk(id: number, value: unknown): ServerFrame {
  return { t: "res", id, ok: true, value: value ?? null };
}

export function makeServerResponseErr(id: number, message: string): ServerFrame {
  return { t: "res", id, ok: false, message };
}

export function makeServerEventFrame(ch: string, args: unknown[]): ServerFrame {
  return { t: "ev", ch, args };
}

export function makeServerFrameStream(key: string): ServerFrame {
  return { t: "frames", key };
}

export type FrameAck = { t: "ack"; id: number };

function isFrameId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= 0xffff_ffff;
}

export function makeFrameAck(id: number): FrameAck {
  return { t: "ack", id };
}

export function parseFrameAck(frame: unknown): FrameAck | null {
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as { t?: unknown; id?: unknown };
  return f.t === "ack" && isFrameId(f.id) ? { t: "ack", id: f.id } : null;
}

/** Path the WebSocket upgrade must target. */
export const REMOTE_WS_PATH = "/ws";
/** Authenticated image delivery, paired to one live reliable connection (#546). */
export const REMOTE_FRAME_WS_PATH = "/ws/frames";
export const REMOTE_FRAME_KEY_PARAM = "key";
/** Cookie the server sets after a successful `?t=` request. */
export const REMOTE_COOKIE = "omp_ui_token";
/** Query parameter carrying the token on the entry URL and the WS upgrade. */
export const REMOTE_TOKEN_PARAM = "t";
/** WebSocket close code used when the token was regenerated. */
export const REMOTE_CLOSE_REVOKED = 4001;

/**
 * Reliable binary event payloads (including `pty:data` and `shell:data`) are
 * never base64-inflated. Browser pane images use FRAME_DELIVERY_KIND separately.
 *
 * layout: [u8 kind=0x01][u16BE channelByteLen][u16BE tabIdByteLen][channel utf8][tabId utf8][payload]
 */
const BINARY_EVENT_KIND = 0x01;
const FRAME_DELIVERY_KIND = 0x02;
const FRAME_ID_BYTES = 4;
const HEADER_BYTES = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBinaryEvent(
  channel: string,
  tabId: string,
  payload: Uint8Array,
): Uint8Array {
  return encodeEvent(channel, tabId, payload, null);
}

/** One sequence-bearing envelope is shared by every viewer of this paint. */
export function encodeFrameDelivery(
  id: number,
  channel: string,
  tabId: string,
  payload: Uint8Array,
): Uint8Array {
  if (!isFrameId(id)) throw new RangeError("invalid frame delivery id");
  return encodeEvent(channel, tabId, payload, id);
}

function encodeEvent(
  channel: string,
  tabId: string,
  payload: Uint8Array,
  id: number | null,
): Uint8Array {
  const ch = encoder.encode(channel);
  const tab = encoder.encode(tabId);
  const offset = id === null ? 0 : FRAME_ID_BYTES;
  const headerBytes = HEADER_BYTES + offset;
  const out = new Uint8Array(headerBytes + ch.length + tab.length + payload.length);
  out[0] = id === null ? BINARY_EVENT_KIND : FRAME_DELIVERY_KIND;
  if (id !== null) new DataView(out.buffer).setUint32(1, id);
  out[offset + 1] = (ch.length >> 8) & 0xff;
  out[offset + 2] = ch.length & 0xff;
  out[offset + 3] = (tab.length >> 8) & 0xff;
  out[offset + 4] = tab.length & 0xff;
  out.set(ch, headerBytes);
  out.set(tab, headerBytes + ch.length);
  out.set(payload, headerBytes + ch.length + tab.length);
  return out;
}

/** null on a short or unknown-kind buffer — a malformed frame is dropped, never thrown. */
export function decodeBinaryEvent(
  buf: Uint8Array,
): { channel: string; tabId: string; payload: Uint8Array } | null {
  if (buf.length < HEADER_BYTES || buf[0] !== BINARY_EVENT_KIND) return null;
  return decodeEvent(buf, 0);
}

export interface FrameDelivery {
  id: number;
  channel: string;
  tabId: string;
  payload: Uint8Array;
}

/** The existing eight-byte pane header is carried unchanged inside payload. */
export function decodeFrameDelivery(
  buf: Uint8Array,
): FrameDelivery | null {
  if (buf.length < HEADER_BYTES + FRAME_ID_BYTES || buf[0] !== FRAME_DELIVERY_KIND) return null;
  const id = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1);
  if (!isFrameId(id)) return null;
  const event = decodeEvent(buf, FRAME_ID_BYTES);
  return event === null ? null : { id, ...event };
}

function decodeEvent(
  buf: Uint8Array,
  offset: number,
): { channel: string; tabId: string; payload: Uint8Array } | null {
  const chLen = (buf[offset + 1] << 8) | buf[offset + 2];
  const tabLen = (buf[offset + 3] << 8) | buf[offset + 4];
  const headerBytes = HEADER_BYTES + offset;
  const chEnd = headerBytes + chLen;
  const tabEnd = chEnd + tabLen;
  if (buf.length < tabEnd) return null;
  return {
    channel: decoder.decode(buf.subarray(headerBytes, chEnd)),
    tabId: decoder.decode(buf.subarray(chEnd, tabEnd)),
    // Copied, not a view: the caller keeps these bytes past the socket's buffer reuse.
    payload: new Uint8Array(buf.subarray(tabEnd)),
  };
}
