/**
 * The remote transport's wire format (issue #37). Pure and dependency-free: the browser client
 * imports this exact module, so nothing here may reach for `node:` or Electron.
 *
 * Protocol versions (issue #442):
 * - protocol 1 is today's wire: the socket opens and req/notify/res/ev frames flow at once.
 * - protocol 2 is hello-first: the client's first text frame is a ClientHello, the server answers
 *   with a ServerHello verdict, and only a `compatible` verdict opens the socket for the frames
 *   above. Every other frame is byte-for-byte the protocol-1 shape.
 */

import type { ClientRole, ProtocolRange } from "@omp-ui/core/types";

export type { ClientRole, ProtocolRange };

/** What a client claims to be. Today one-to-one with its role; kept separate so a role may grow variants. */
export type ClientKind = ClientRole;

/** Protocol number this host speaks. */
export const HOST_PROTOCOL = 2;
/** Inclusive range of client protocols this host accepts. */
export const HOST_PROTOCOL_RANGE: ProtocolRange = { min: 1, max: 2 };
/** WebSocket close code for a failed hello (role mismatch, protocol out of range, hello required). */
export const HOST_CLOSE_INCOMPATIBLE = 4002;
/** Matches core/rpc's maximum reassembled logical frame. */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
/** Request header a joined-instance dial carries; the value "instance" marks it. */
export const INSTANCE_CLIENT_HEADER = "x-omp-ui-client";

/** First text frame of a protocol-2 client. */
export interface ClientHello {
  t: "hello";
  clientRole: ClientRole;
  clientKind: ClientKind;
  clientVersion: string;
  clientProtocol: number;
}

/** The host's answer to a ClientHello; `incompatible` is followed by a HOST_CLOSE_INCOMPATIBLE close. */
export interface ServerHello {
  t: "hello";
  verdict: "compatible" | "incompatible";
  hostVersion: string;
  hostProtocol: number;
  protocolRange: ProtocolRange;
  reason: string | null;
}

/** Everything the server knows about one socket; handed to the surface so tables are per-connection. */
export interface ConnectionContext {
  id: string;
  role: ClientRole;
  /** The socket came in over loopback (the server's `local` option), not a credential property. */
  local: boolean;
  /** Whether the grant allows control-plane channels. */
  control: boolean;
  clientKind: ClientKind;
  /** Empty string until a hello names it (protocol 1 never does). */
  clientVersion: string;
  protocolVersion: number;
}

const CLIENT_ROLES: Record<ClientRole, true> = { browser: true, desktop: true, instance: true };

function isRole(v: unknown): v is ClientRole {
  return typeof v === "string" && v in CLIENT_ROLES;
}

function isInteger(v: unknown): v is number {
  return Number.isInteger(v);
}

function isProtocolRange(v: unknown): v is ProtocolRange {
  if (v === null || typeof v !== "object") return false;
  const r = v as { min?: unknown; max?: unknown };
  return isInteger(r.min) && isInteger(r.max);
}

/** Strict narrowing of a client hello: every field present and typed, or null. */
export function parseClientHello(frame: unknown): ClientHello | null {
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as {
    t?: unknown;
    clientRole?: unknown;
    clientKind?: unknown;
    clientVersion?: unknown;
    clientProtocol?: unknown;
  };
  if (f.t !== "hello") return null;
  if (!isRole(f.clientRole)) return null;
  if (typeof f.clientKind !== "string") return null;
  if (typeof f.clientVersion !== "string") return null;
  if (!isInteger(f.clientProtocol) || f.clientProtocol < 1) return null;
  return {
    t: "hello",
    clientRole: f.clientRole,
    // ClientKind is ClientRole today, but a kind is a free-form claim; the string check is the contract.
    clientKind: f.clientKind as ClientKind,
    clientVersion: f.clientVersion,
    clientProtocol: f.clientProtocol,
  };
}

/** Strict narrowing of a server hello — mirror of parseClientHello. */
export function parseServerHello(frame: unknown): ServerHello | null {
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as {
    t?: unknown;
    verdict?: unknown;
    hostVersion?: unknown;
    hostProtocol?: unknown;
    protocolRange?: unknown;
    reason?: unknown;
  };
  if (f.t !== "hello") return null;
  if (f.verdict !== "compatible" && f.verdict !== "incompatible") return null;
  if (typeof f.hostVersion !== "string") return null;
  if (!isInteger(f.hostProtocol)) return null;
  if (!isProtocolRange(f.protocolRange)) return null;
  if (f.reason !== null && typeof f.reason !== "string") return null;
  return {
    t: "hello",
    verdict: f.verdict,
    hostVersion: f.hostVersion,
    hostProtocol: f.hostProtocol,
    protocolRange: { min: f.protocolRange.min, max: f.protocolRange.max },
    reason: f.reason,
  };
}

export function makeClientHello(h: Omit<ClientHello, "t">): ClientHello {
  return { t: "hello", ...h };
}

export function makeServerHello(h: Omit<ServerHello, "t">): ServerHello {
  return { t: "hello", ...h };
}

/** JSON frames. Binary event payloads use encodeBinaryEvent below instead. */
export type ClientFrame =
  | { t: "req"; id: number; ch: string; args: unknown[] }
  | { t: "notify"; ch: string; args: unknown[] }
  | ClientHello;

/**
 * The one narrowing for inbound JSON frames (issue #301). A well-formed frame comes back
 * with `args` normalized to an array — a missing `args` dispatches with no arguments, as
 * the server did before. Anything else (non-object, missing `ch`, a non-numeric `id` on a
 * req, a present-but-non-array `args`) is null: dropped, never thrown. A hello delegates
 * to parseClientHello.
 */
export function parseClientFrame(frame: unknown): ClientFrame | null {
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as { t?: unknown; id?: unknown; ch?: unknown; args?: unknown };
  if (f.t === "hello") return parseClientHello(frame);
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
  | ServerHello;

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
  };
  if (f.t === "hello") return parseServerHello(frame);
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

/** Path the WebSocket upgrade must target. */
export const REMOTE_WS_PATH = "/ws";
/** Cookie the server sets after a successful `?t=` request. */
export const REMOTE_COOKIE = "omp_ui_token";
/** Query parameter carrying the token on the entry URL and the WS upgrade. */
export const REMOTE_TOKEN_PARAM = "t";
/** WebSocket close code used when the token was regenerated. */
export const REMOTE_CLOSE_REVOKED = 4001;

/**
 * Binary event frame kind. `pty:data` and `shell:data` are the only OmpBackend payloads that are
 * bytes; they ride WebSocket binary frames so nothing is base64-inflated on the way to xterm.
 *
 * layout: [u8 kind=0x01][u16BE channelByteLen][u16BE tabIdByteLen][channel utf8][tabId utf8][payload]
 */
const BINARY_EVENT_KIND = 0x01;
const HEADER_BYTES = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBinaryEvent(
  channel: string,
  tabId: string,
  payload: Uint8Array,
): Uint8Array {
  const ch = encoder.encode(channel);
  const tab = encoder.encode(tabId);
  const out = new Uint8Array(HEADER_BYTES + ch.length + tab.length + payload.length);
  out[0] = BINARY_EVENT_KIND;
  out[1] = (ch.length >> 8) & 0xff;
  out[2] = ch.length & 0xff;
  out[3] = (tab.length >> 8) & 0xff;
  out[4] = tab.length & 0xff;
  out.set(ch, HEADER_BYTES);
  out.set(tab, HEADER_BYTES + ch.length);
  out.set(payload, HEADER_BYTES + ch.length + tab.length);
  return out;
}

/** null on a short or unknown-kind buffer — a malformed frame is dropped, never thrown. */
export function decodeBinaryEvent(
  buf: Uint8Array,
): { channel: string; tabId: string; payload: Uint8Array } | null {
  if (buf.length < HEADER_BYTES || buf[0] !== BINARY_EVENT_KIND) return null;
  const chLen = (buf[1] << 8) | buf[2];
  const tabLen = (buf[3] << 8) | buf[4];
  const chEnd = HEADER_BYTES + chLen;
  const tabEnd = chEnd + tabLen;
  if (buf.length < tabEnd) return null;
  return {
    channel: decoder.decode(buf.subarray(HEADER_BYTES, chEnd)),
    tabId: decoder.decode(buf.subarray(chEnd, tabEnd)),
    // Copied, not a view: the caller keeps these bytes past the socket's buffer reuse.
    payload: buf.slice(tabEnd),
  };
}
