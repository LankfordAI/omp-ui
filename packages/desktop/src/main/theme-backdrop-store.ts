import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** A backdrop asset name: the bare lowercase SHA-256 of its bytes (issue #1168). */
const ASSET_HASH = /^[0-9a-f]{64}$/;

/**
 * Backdrop assets live beside the registry, one file per content hash, so the
 * registry carries only a small reference (issue #1168). Every method tests the
 * hash before building a path: no caller-supplied string ever reaches the disk.
 */
export class ThemeBackdropStore {
  constructor(private readonly dir: string) {}

  /** Writes bytes under their SHA-256 (atomic: temp file then rename) and returns the hash. */
  async put(bytes: Uint8Array): Promise<string> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, hash);
    const temp = path.join(this.dir, `.${hash}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temp, bytes, { mode: 0o600 });
      await fs.promises.rename(temp, target);
    } catch (error) {
      await fs.promises.rm(temp, { force: true });
      throw error;
    }
    return hash;
  }

  /** The stored bytes, or null when the hash is unknown or malformed. */
  async read(assetHash: string): Promise<Uint8Array | null> {
    if (!ASSET_HASH.test(assetHash)) return null;
    try {
      return new Uint8Array(await fs.promises.readFile(path.join(this.dir, assetHash)));
    } catch {
      return null;
    }
  }

  async has(assetHash: string): Promise<boolean> {
    if (!ASSET_HASH.test(assetHash)) return false;
    try {
      return (await fs.promises.stat(path.join(this.dir, assetHash))).isFile();
    } catch {
      return false;
    }
  }

  /** Deletes every stored file whose hash is not in `keep`. Never throws. */
  async prune(keep: ReadonlySet<string>): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => ASSET_HASH.test(name) && !keep.has(name))
        .map((name) => fs.promises.rm(path.join(this.dir, name), { force: true }).catch(() => {})),
    );
  }
}
