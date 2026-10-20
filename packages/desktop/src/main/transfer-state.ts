// Host-local staging state for #888 bundle transfers. The pack side holds an
// open temp archive (transcript data); the ingest side holds an append-writer
// building one. Both live in 0700 mkdtemp dirs with 0600 files and are shredded
// — zero-filled, then unlinked — on abort, finish, or the idle sweep: a renderer
// that dies mid-transfer must not strand a bundle on disk.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { shredFile } from "@omp-ui/core";

/** Raw bytes per base64 chunk frame; base64 overhead keeps every frame far
 * under the reliable socket's MAX_PAYLOAD (packages/server/src/index.ts). */
export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;

// A transfer untouched for this long is abandoned (renderer died mid-flight);
// the sweep shreds it. Generous enough that a slow remote link never trips it.
const IDLE_EXPIRY_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PackEntry {
  dir: string;
  file: string;
  startedAt: number;
  sizeBytes: number;
}

interface IngestEntry {
  dir: string;
  file: string;
  startedAt: number;
  stream: fs.WriteStream;
  failed: Error | null;
}

/** Executor-form promise helper (kept from the core ES2022 convention). */
function opened(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("open", resolve);
    stream.once("error", reject);
    stream.once("close", () => reject(new Error("write stream closed before opening")));
  });
}

/** packId → open temp archive; ingest transferId → open temp writer. */
export class TransferState {
  private readonly packs = new Map<string, PackEntry>();
  private readonly ingests = new Map<string, IngestEntry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Never hold the event loop open for housekeeping.
    this.sweeper.unref();
  }

  /** Stage a pack dir with a pre-created 0600 bundle file; the caller runs
   * `omp session pack` into it. */
  async startPack(): Promise<{ packId: string; dir: string; file: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-ui-pack-"));
    await fs.promises.chmod(dir, 0o700);
    const file = path.join(dir, "bundle.tar");
    // Pre-create at 0600 so omp's own write lands on a secret-mode file.
    await fs.promises.writeFile(file, "", { mode: 0o600 });
    const packId = randomUUID();
    this.packs.set(packId, { dir, file, startedAt: Date.now(), sizeBytes: 0 });
    return { packId, dir, file };
  }

  /** Record the packed size after a successful `omp session pack`. */
  notePackSize(packId: string, sizeBytes: number): void {
    const entry = this.packs.get(packId);
    if (entry) entry.sizeBytes = sizeBytes;
  }

  /** Base64 of raw bytes `[index*CHUNK, min(size, (index+1)*CHUNK))`; empty
   * string past the end. Refuses unknown/expired ids. */
  async readChunk(packId: string, index: number): Promise<string> {
    const entry = this.packs.get(packId);
    if (!entry) throw new Error("unknown or expired pack");
    entry.startedAt = Date.now();
    const start = index * TRANSFER_CHUNK_BYTES;
    if (start >= entry.sizeBytes) return "";
    const length = Math.min(TRANSFER_CHUNK_BYTES, entry.sizeBytes - start);
    const handle = await fs.promises.open(entry.file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("base64");
    } finally {
      await handle.close();
    }
  }

  async abortPack(packId: string): Promise<void> {
    const entry = this.packs.get(packId);
    if (!entry) return;
    this.packs.delete(packId);
    await this.removeStaging(entry.dir, entry.file);
  }

  /** Open an append-writer for an incoming bundle; returns its transferId. */
  async startIngest(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-ui-ingest-"));
    await fs.promises.chmod(dir, 0o700);
    const file = path.join(dir, "bundle.tar");
    const transferId = randomUUID();
    const stream = fs.createWriteStream(file, { mode: 0o600 });
    const entry: IngestEntry = { dir, file, startedAt: Date.now(), stream, failed: null };
    stream.on("error", (err) => {
      entry.failed = err instanceof Error ? err : new Error(String(err));
    });
    try {
      await opened(stream);
    } catch (err) {
      await this.removeStaging(dir, file);
      throw err;
    }
    this.ingests.set(transferId, entry);
    return transferId;
  }

  /** Append one decoded chunk. Arrival order is the chunk order: a single
   * renderer drives each transfer (the store slice never parallelizes pushes). */
  async push(transferId: string, chunkBase64: string): Promise<void> {
    const entry = this.ingests.get(transferId);
    if (!entry) throw new Error("unknown or expired transfer");
    entry.startedAt = Date.now();
    if (entry.failed) throw entry.failed;
    const wrote = entry.stream.write(Buffer.from(chunkBase64, "base64"));
    if (!wrote) await this.drain(entry);
  }

  private drain(entry: IngestEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        entry.stream.off("error", failed);
        resolve();
      };
      const failed = (err: Error): void => {
        entry.stream.off("drain", done);
        entry.failed ??= err;
        reject(err);
      };
      entry.stream.once("drain", done);
      entry.stream.once("error", failed);
    });
  }

  /** Close the writer and return the assembled bundle's path. */
  async finishIngest(transferId: string): Promise<string> {
    const entry = this.ingests.get(transferId);
    if (!entry) throw new Error("unknown or expired transfer");
    this.ingests.delete(transferId);
    await new Promise<void>((resolve, reject) => {
      entry.stream.once("close", resolve);
      entry.stream.once("error", reject);
      entry.stream.end();
    });
    if (entry.failed) throw entry.failed;
    return entry.file;
  }

  /** Drop a transfer whose bundle is staged but no longer wanted. */
  async abortIngest(transferId: string): Promise<void> {
    const entry = this.ingests.get(transferId);
    if (!entry) return;
    this.ingests.delete(transferId);
    entry.stream.destroy();
    await this.removeStaging(entry.dir, entry.file);
  }

  /** Stop the sweep (shutdown/test teardown). */
  dispose(): void {
    clearInterval(this.sweeper);
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - IDLE_EXPIRY_MS;
    for (const [packId, entry] of this.packs) {
      if (entry.startedAt < cutoff) {
        this.packs.delete(packId);
        await this.removeStaging(entry.dir, entry.file);
      }
    }
    for (const [transferId, entry] of this.ingests) {
      if (entry.startedAt < cutoff) {
        this.ingests.delete(transferId);
        entry.stream.destroy();
        await this.removeStaging(entry.dir, entry.file);
      }
    }
  }

  private async removeStaging(dir: string, file: string): Promise<void> {
    try {
      await shredFile(file);
    } catch {
      // Best-effort: fall through to the recursive removal anyway.
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
