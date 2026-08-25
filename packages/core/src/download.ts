import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultDownloadFetch, type DownloadFetchLike } from "./fetch";

export const MAX_UPDATE_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export interface AtomicDownloadOptions {
  url: string;
  targetPath: string;
  description: string;
  fetchImpl?: DownloadFetchLike;
  maxBytes?: number;
  mode?: number;
  expectedSha256?: string;
  validateTemp?: (tempPath: string) => Promise<void>;
  onProgress?: (percent: number | null) => void;
}

function tempPathFor(targetPath: string): string {
  const extension = path.extname(targetPath);
  const stem = extension === "" ? targetPath : targetPath.slice(0, -extension.length);
  return `${stem}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}${extension}`;
}

/** Streams, validates, and atomically commits one bounded download. */
export async function downloadFileAtomically(opts: AtomicDownloadOptions): Promise<void> {
  const maxBytes = opts.maxBytes ?? MAX_UPDATE_DOWNLOAD_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }

  const response = await (opts.fetchImpl ?? defaultDownloadFetch)(opts.url, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new Error(`failed to download ${opts.description}: HTTP ${response.status}`);
  }

  const lengthHeader = response.headers?.get?.("content-length") ?? null;
  const declaredBytes = lengthHeader === null ? NaN : Number(lengthHeader);
  const determinate = Number.isFinite(declaredBytes) && declaredBytes > 0;
  if (determinate && declaredBytes > maxBytes) {
    throw new Error(`download exceeds ${maxBytes} byte limit for ${opts.description}`);
  }
  if (!determinate) opts.onProgress?.(null);

  await fs.promises.mkdir(path.dirname(opts.targetPath), { recursive: true });
  const tempPath = tempPathFor(opts.targetPath);
  const hash = opts.expectedSha256 === undefined ? null : crypto.createHash("sha256");
  let handle: fs.promises.FileHandle | null = null;
  let received = 0;
  let lastProgress = -1;

  const writeChunk = async (value: Uint8Array): Promise<void> => {
    if (value.byteLength === 0) return;
    received += value.byteLength;
    if (received > maxBytes) {
      throw new Error(`download exceeds ${maxBytes} byte limit for ${opts.description}`);
    }
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let written = 0;
    while (written < chunk.byteLength) {
      const result = await handle!.write(chunk, written, chunk.byteLength - written, null);
      written += result.bytesWritten;
    }
    hash?.update(chunk);
    if (determinate) {
      const progress = Math.min(100, Math.floor((received / declaredBytes) * 100));
      if (progress > lastProgress) {
        lastProgress = progress;
        opts.onProgress?.(progress);
      }
    }
  };

  try {
    handle = await fs.promises.open(tempPath, "wx");
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeChunk(value ?? new Uint8Array());
      }
    } else {
      await writeChunk(new Uint8Array(await response.arrayBuffer()));
    }

    await handle.close();
    handle = null;
    if (opts.mode !== undefined) await fs.promises.chmod(tempPath, opts.mode);

    if (hash !== null) {
      const actual = hash.digest("hex");
      if (actual.toLowerCase() !== opts.expectedSha256!.toLowerCase()) {
        throw new Error(`checksum mismatch for ${path.basename(opts.targetPath)}`);
      }
    }
    await opts.validateTemp?.(tempPath);
    await fs.promises.rename(tempPath, opts.targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
