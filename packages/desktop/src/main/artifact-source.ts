import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { ArtifactError } from "@omp-ui/core";

export const ARTIFACT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_SOURCE_TIMEOUT_MS = 30_000;

export function canonicalArtifactArguments(value: unknown): string {
  const visit = (item: unknown, depth: number): string => {
    if (depth > 64) throw new ArtifactError("over-limit", "Artifact arguments exceed depth 64");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map((entry) => visit(entry, depth + 1)).join(",")}]`;
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.keys(item).sort().map((key) => {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new ArtifactError("unsupported-contract", "Unsafe argument key");
        return `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`;
      }).join(",")}}`;
    }
    throw new ArtifactError("unsupported-contract", "Arguments must be finite JSON");
  };
  return visit(value, 0);
}

export function artifactSourceHash(args: unknown): string {
  return createHash("sha256").update(canonicalArtifactArguments(args)).digest("hex");
}

type Scalar = string | number | boolean | null;
type Container = { kind: "object" | "array"; path: string[]; key: string | null; index: number; expectingKey: boolean };

/** A bounded metadata tokenizer. Large strings and arguments are never retained.
 * The second pass reads only the exact selected record, bounded at 64 MiB. */
class MetadataScanner {
  private stack: Container[] = [];
  private token = "";
  private string = false;
  private escaped = false;
  private oversized = false;
  private discarded = false;
  constructor(private readonly scalar: (path: string[], value: Scalar) => void) {}
  private nextPath(): string[] {
    const parent = this.stack.at(-1);
    return parent === undefined ? [] : [...parent.path, parent.kind === "array" ? String(parent.index) : parent.key ?? ""];
  }
  private consumed(): void {
    const parent = this.stack.at(-1);
    if (parent === undefined) return;
    if (parent.kind === "array") parent.index++;
    else { parent.key = null; parent.expectingKey = true; }
  }
  private finish(quoted: boolean): void {
    const parent = this.stack.at(-1);
    let value: Scalar = null;
    if (!this.oversized) {
      try {
        const token = quoted ? Buffer.from(this.token, "latin1").toString("utf8") : this.token;
        value = JSON.parse(quoted ? `"${token}"` : token) as Scalar;
      } catch { /* malformed records never qualify */ }
    }
    if (quoted && parent?.kind === "object" && parent.expectingKey) {
      parent.key = typeof value === "string" ? value : "";
      parent.expectingKey = false;
    } else {
      this.scalar(this.nextPath(), value);
      this.consumed();
    }
    this.token = "";
    this.oversized = false;
  }
  feed(bytes: Buffer): void {
    if (this.discarded) return;
    // Keep bounded raw UTF-8 bytes; decode only complete metadata tokens.
    for (const byte of bytes) {
      const char = String.fromCharCode(byte);
      if (this.string) {
        if (!this.escaped && char === '"') { this.string = false; this.finish(true); continue; }
        if (!this.oversized) {
          if (this.token.length < 2048) this.token += char;
          else { this.token = ""; this.oversized = true; }
        }
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        continue;
      }
      if (this.token !== "" && /[\s,\]}]/.test(char)) this.finish(false);
      if (char === '"') { this.string = true; continue; }
      if (char === "{" || char === "[") {
        if (this.stack.length >= 128) { this.discarded = true; this.stack = []; return; }
        this.stack.push({ kind: char === "{" ? "object" : "array", path: this.nextPath(), key: null, index: 0, expectingKey: true });
      } else if (char === "}" || char === "]") {
        this.stack.pop(); this.consumed();
      } else if (!/[\s,:]/.test(char)) {
        if (this.token.length < 64) this.token += char;
        else this.oversized = true;
      }
    }
  }
}

function sourceStream(file: string, signal: AbortSignal): { input: Readable; output: Readable } {
  const input = createReadStream(file, { signal, highWaterMark: 64 * 1024 });
  if (!file.endsWith(".gz")) return { input, output: input };
  const output = createGunzip();
  input.on("error", (error) => output.destroy(error));
  input.pipe(output);
  const abort = (): void => { input.destroy(); output.destroy(new Error("source-missing: source read aborted")); };
  signal.addEventListener("abort", abort, { once: true });
  output.once("close", () => signal.removeEventListener("abort", abort));
  return { input, output };
}

async function scanLines(file: string, signal: AbortSignal, line: (chunk: Buffer, end: boolean, start: number, size: number) => void): Promise<void> {
  const { input, output } = sourceStream(file, signal);
  let start = 0;
  let size = 0;
  try {
    for await (const data of output) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
      let from = 0;
      for (;;) {
        const newline = bytes.indexOf(10, from);
        if (newline < 0) break;
        const part = bytes.subarray(from, newline);
        size += part.length;
        line(part, true, start, size);
        start += size + 1; size = 0; from = newline + 1;
      }
      if (from < bytes.length) {
        const part = bytes.subarray(from); size += part.length; line(part, false, start, size);
      }
    }
    if (size !== 0) line(Buffer.alloc(0), true, start, size);
  } finally { output.destroy(); input.destroy(); }
}

export interface HistoricalArtifactSourceRequest {
  file: string;
  sessionId: string;
  toolCallId: string;
  sourceHash: string;
  signal?: AbortSignal;
}

/** Main supplies the path and expected session identity; no renderer-provided body is trusted. */
export async function readHistoricalArtifactSource(request: HistoricalArtifactSourceRequest): Promise<{ args: unknown; timestamp: string | null }> {
  const signal = request.signal === undefined ? AbortSignal.timeout(ARTIFACT_SOURCE_TIMEOUT_MS)
    : AbortSignal.any([request.signal, AbortSignal.timeout(ARTIFACT_SOURCE_TIMEOUT_MS)]);
  let header: string | null = null;
  let candidate: { start: number; size: number } | null = null;
  let success = false;
  let fields = new Map<string, Scalar>();
  let blockIndex = "";
  let block = new Map<string, Scalar>();
  let matches = 0;
  let blockMatched = false;
  const metadata = (path: string[], value: Scalar): void => {
    const key = path.join(".");
    if (["type", "id", "message.role", "message.toolCallId", "message.toolName", "message.isError"].includes(key)) fields.set(key, value);
    if (path.length !== 4 || path[0] !== "message" || path[1] !== "content" || !["type", "id", "name"].includes(path[3]!)) return;
    if (blockIndex !== path[2]) { blockIndex = path[2]!; block = new Map(); blockMatched = false; }
    block.set(path[3]!, value);
    if (!blockMatched && block.get("type") === "toolCall" && block.get("id") === request.toolCallId && block.get("name") === "omp-ui_render_html") {
      matches++; blockMatched = true;
    }
  };
  let scanner = new MetadataScanner(metadata);
  await scanLines(request.file, signal, (chunk, end, start, size) => {
    scanner.feed(chunk);
    if (!end) return;
    if (fields.get("type") === "session") {
      if (header !== null || fields.get("id") !== request.sessionId) throw new ArtifactError("source-missing", "Unexpected session header");
      header = request.sessionId;
    }
    if (fields.get("type") === "message" && fields.get("message.role") === "assistant" && matches > 0) {
      if (header !== request.sessionId) throw new ArtifactError("source-missing", "Source call precedes its session header");
      if (candidate !== null || matches > 1) throw new ArtifactError("source-missing", "Duplicate native tool call identity");
      if (size > ARTIFACT_SOURCE_MAX_BYTES) throw new ArtifactError("over-limit", "Target source record exceeds 64 MiB");
      candidate = { start, size };
    }
    if (fields.get("type") === "message" && fields.get("message.role") === "toolResult"
      && fields.get("message.toolCallId") === request.toolCallId) {
      success = candidate !== null && fields.get("message.toolName") === "omp-ui_render_html" && fields.get("message.isError") === false;
    }
    fields = new Map(); block = new Map(); blockIndex = ""; matches = 0; blockMatched = false;
    scanner = new MetadataScanner(metadata);
  });
  if (header !== request.sessionId || candidate === null || !success) throw new ArtifactError("source-missing", "Successful source tool call not found");
  const selected = candidate as { start: number; size: number };
  const pieces: Buffer[] = [];
  await scanLines(request.file, signal, (chunk, _end, start, size) => {
    if (start !== selected.start) return;
    if (size > ARTIFACT_SOURCE_MAX_BYTES) throw new ArtifactError("over-limit", "Target source changed while reading");
    if (chunk.length > 0) pieces.push(Buffer.from(chunk));
  });
  const bytes = Buffer.concat(pieces);
  if (bytes.length !== selected.size) throw new ArtifactError("source-missing", "Source changed while reading");
  const record = JSON.parse(bytes.toString("utf8")) as { timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
  if (record.message?.role !== "assistant" || !Array.isArray(record.message.content)) throw new ArtifactError("source-missing", "Source changed while reading");
  const call = record.message.content.find((item: unknown) => item !== null && typeof item === "object"
    && (item as Record<string, unknown>).id === request.toolCallId) as Record<string, unknown> | undefined;
  if (call?.type !== "toolCall" || call.name !== "omp-ui_render_html" || artifactSourceHash(call.arguments) !== request.sourceHash) {
    throw new ArtifactError("source-missing", "Source arguments do not match");
  }
  return { args: call.arguments, timestamp: typeof record.timestamp === "string" ? record.timestamp : null };
}
