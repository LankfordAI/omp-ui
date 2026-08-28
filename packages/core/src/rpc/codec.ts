/**
 * A parsed NDJSON frame. The protocol emits records; every field stays
 * `unknown` — observers narrow per field and never re-cast the whole frame.
 * A non-object JSON line is a protocol violation the client tolerates by
 * treating it as inert (its frame handlers keep the record guards).
 */
export type RpcFrame = {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  [key: string]: unknown;
};

import { isObject } from "../guards";

// Re-exports: the canonical guard lives in guards.ts, and the control-frame
// grammar in rpc/control-frames.ts — split out so the web build (no node
// globals; this file references Buffer) can normalize frames too. The names
// stay importable from here for the node side.
export { isObject };
export {
  normalizeControlFrame,
  type RpcControlFrame,
  type WireRecord,
} from "./control-frames";

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/**
 * Protocol-v2 frame reassembler. Plain NDJSON frames pass through; rpc_chunk
 * sequences (same chunkId, index from 0, consistent count/byteLength, ≤ 64
 * MiB accumulated) are concatenated, UTF-8 decoded, and parsed as one frame.
 * Every invariant violation → onProtocolError (the caller kills the process —
 * a peer that breaks framing gets no second chance).
 */
export class RpcChunkReassembler {
  #chunkId: string | null = null;
  #count = 0;
  #byteLength = 0;
  #nextIndex = 0;
  #parts: Buffer[] = [];
  #bytes = 0;
  readonly #maxReassembledBytes: number;

  constructor(
    private readonly onFrame: (frame: RpcFrame) => void,
    private readonly onProtocolError: (msg: string) => void,
    maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES,
  ) {
    this.#maxReassembledBytes = maxReassembledBytes;
  }

  pushLine(line: string): void {
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.onProtocolError(`invalid JSON frame: ${line.slice(0, 120)}`);
      return;
    }
    if (isObject(frame) && frame.type === "rpc_chunk") {
      this.#pushChunk(frame);
      return;
    }
    this.onFrame(frame);
  }

  #pushChunk(frame: Record<string, unknown>): void {
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      typeof byteLength !== "number" ||
      typeof data !== "string"
    ) {
      this.onProtocolError("malformed rpc_chunk fields");
      return;
    }

    if (this.#chunkId === null) {
      if (index !== 0) {
        this.onProtocolError(`rpc_chunk stream starts at index ${index}, expected 0`);
        return;
      }
      this.#chunkId = chunkId;
      this.#count = count;
      this.#byteLength = byteLength;
    } else {
      if (chunkId !== this.#chunkId) {
        this.onProtocolError("rpc_chunk chunkId changed mid-stream");
        return;
      }
      if (count !== this.#count || byteLength !== this.#byteLength) {
        this.onProtocolError("rpc_chunk count/byteLength inconsistent across chunks");
        return;
      }
    }
    if (index !== this.#nextIndex) {
      this.onProtocolError(`rpc_chunk index ${index}, expected ${this.#nextIndex}`);
      return;
    }

    const part = Buffer.from(data, "base64");
    this.#bytes += part.length;
    if (this.#bytes > this.#maxReassembledBytes) {
      this.#reset();
      this.onProtocolError("rpc_chunk reassembly exceeds 64 MiB cap");
      return;
    }
    this.#parts.push(part);
    this.#nextIndex++;

    if (this.#nextIndex === this.#count) {
      const text = Buffer.concat(this.#parts).toString("utf8");
      this.#reset();
      try {
        this.onFrame(JSON.parse(text));
      } catch {
        this.onProtocolError("reassembled frame is not valid JSON");
      }
    }
  }

  #reset(): void {
    this.#chunkId = null;
    this.#parts = [];
    this.#bytes = 0;
    this.#nextIndex = 0;
  }
}
