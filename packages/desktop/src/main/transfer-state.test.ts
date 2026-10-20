import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TransferState, TRANSFER_CHUNK_BYTES } from "./transfer-state";

// Staging dirs captured during tests so teardown sweeps them even on failure.
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TransferState (issue #888)", () => {
  it("round-trips pack chunks through ingest push/finish byte-exactly", async () => {
    const state = new TransferState();
    try {
      const pack = await state.startPack();
      dirs.push(pack.dir);
      const payload = Buffer.concat([Buffer.alloc(1024, 0xab), Buffer.from("bundle tail")]);
      await fs.promises.writeFile(pack.file, payload);
      state.notePackSize(pack.packId, payload.length);

      const first = await state.readChunk(pack.packId, 0);
      expect(Buffer.from(first, "base64")).toEqual(payload);
      await expect(state.readChunk(pack.packId, 1)).resolves.toBe("");

      const transferId = await state.startIngest();
      await state.push(transferId, first);
      const bundle = await state.finishIngest(transferId);
      dirs.push(path.dirname(bundle));
      expect(await fs.promises.readFile(bundle)).toEqual(payload);
      // finish detaches the transfer; a late push is refused.
      await expect(state.push(transferId, "eA==")).rejects.toThrow(/unknown or expired transfer/);
    } finally {
      state.dispose();
    }
  });

  it("reads chunks only within the recorded size and refuses unknown packs", async () => {
    const state = new TransferState();
    try {
      const pack = await state.startPack();
      dirs.push(pack.dir);
      await fs.promises.writeFile(pack.file, Buffer.alloc(TRANSFER_CHUNK_BYTES + 5, 7));
      state.notePackSize(pack.packId, TRANSFER_CHUNK_BYTES + 5);
      expect(
        Buffer.from(await state.readChunk(pack.packId, 0), "base64").equals(
          Buffer.alloc(TRANSFER_CHUNK_BYTES, 7),
        ),
      ).toBe(true);
      expect(
        Buffer.from(await state.readChunk(pack.packId, 1), "base64").equals(Buffer.alloc(5, 7)),
      ).toBe(true);
      await expect(state.readChunk("nope", 0)).rejects.toThrow(/unknown or expired pack/);
    } finally {
      state.dispose();
    }
  });

  it("abortPack shreds the bundle and removes the staging dir", async () => {
    const state = new TransferState();
    try {
      const pack = await state.startPack();
      await fs.promises.writeFile(pack.file, "secret transcript bytes");
      await state.abortPack(pack.packId);
      expect(fs.existsSync(pack.file)).toBe(false);
      expect(fs.existsSync(pack.dir)).toBe(false);
      await expect(state.readChunk(pack.packId, 0)).rejects.toThrow(/unknown or expired pack/);
    } finally {
      state.dispose();
    }
  });

  it("finish detaches the transfer and refuses a second finish", async () => {
    const state = new TransferState();
    try {
      await expect(state.push("nope", "eA==")).rejects.toThrow(/unknown or expired transfer/);
      const id = await state.startIngest();
      const bundle = await state.finishIngest(id);
      dirs.push(path.dirname(bundle));
      await expect(state.finishIngest(id)).rejects.toThrow(/unknown or expired transfer/);
    } finally {
      state.dispose();
    }
  });
});
