import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { asBuffer, defaultWorkerEntry, runProtectorInWorker, type ProtectorSpec } from "./dek-worker";
import { DekTimeout } from "./host-key-cipher";

const ADDON_BUILT = fs.existsSync(
  new URL("./linux-secret-service/build/Release/secret_service.node", import.meta.url),
);

const spec: ProtectorSpec = { backend: "linux-secret-service", dataRoot: "/tmp/omp-ui-test" };

/** Inline entries (`eval: true`) stand in for the real one; `require` is available to an eval'd CommonJS worker. */
const HANG = { source: "setInterval(() => {}, 1000);" };
const ECHO = {
  source: `
    const { parentPort, workerData } = require("node:worker_threads");
    parentPort.postMessage({ ok: true, value: { seen: workerData, bytes: Buffer.from([1, 2, 3]) } });
  `,
};
const FAIL = {
  source: `
    const { parentPort } = require("node:worker_threads");
    parentPort.postMessage({ ok: false, message: "keyring locked" });
  `,
};
const CRASH = { source: `throw new Error("boom");` };
const SILENT_EXIT = { source: `process.exit(3);` };

describe("runProtectorInWorker", () => {
  // Real clock on purpose: the deadline terminates a genuine Worker thread,
  // which fake timers cannot stand in for.
  it("terminates a worker that never answers and rejects with DekTimeout at the deadline", async () => {
    await expect(runProtectorInWorker(spec, { name: "lookup", args: [] }, 50, HANG)).rejects.toBeInstanceOf(
      DekTimeout,
    );
  });

  it("delivers the spec and op to the worker and returns its structured-cloned value", async () => {
    const op = { name: "store", args: ["schema", new Uint8Array([9])] };
    const value = (await runProtectorInWorker(spec, op, 5000, ECHO)) as {
      seen: { backend: string; dataRoot: string; op: { name: string; args: unknown[] } };
      bytes: Uint8Array;
    };
    expect(value.seen.backend).toBe(spec.backend);
    expect(value.seen.dataRoot).toBe(spec.dataRoot);
    expect(value.seen.op.name).toBe("store");
    expect(Array.from(value.seen.op.args[1] as Uint8Array)).toEqual([9]);
    expect(asBuffer(value.bytes, "echo").equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("surfaces the entry's posted error message", async () => {
    await expect(runProtectorInWorker(spec, { name: "lookup", args: [] }, 5000, FAIL)).rejects.toThrow(
      "keyring locked",
    );
  });

  it("rejects when the worker throws before posting", async () => {
    await expect(runProtectorInWorker(spec, { name: "lookup", args: [] }, 5000, CRASH)).rejects.toThrow("boom");
  });

  it("rejects when the worker exits without answering", async () => {
    await expect(runProtectorInWorker(spec, { name: "lookup", args: [] }, 5000, SILENT_EXIT)).rejects.toThrow(
      "exited with code 3",
    );
  });

  it("asBuffer refuses non-bytes", () => {
    expect(() => asBuffer("nope", "key")).toThrow("expected bytes");
  });
});

describe("dek-worker-entry.cjs", () => {
  it("names an unknown backend", async () => {
    // Deliberately outside NativeBackend: the entry, not the type, is under test.
    const bogus = { backend: "plaintext", dataRoot: "/x" } as unknown as ProtectorSpec;
    await expect(runProtectorInWorker(bogus, { name: "lookup", args: [] }, 5000, defaultWorkerEntry())).rejects.toThrow(
      "unknown credential backend: plaintext",
    );
  });

  it("names an unknown op for a known backend", async () => {
    await expect(runProtectorInWorker(spec, { name: "erase", args: [] }, 5000)).rejects.toThrow(
      "unknown linux-secret-service op: erase",
    );
  });

  // A built addon would reach the real keyring here; the unbuilt path is what this asserts.
  it.skipIf(ADDON_BUILT)("reports an unbuilt libsecret addon as the error, not a crash", async () => {
    await expect(runProtectorInWorker(spec, { name: "lookup", args: ["schema"] }, 5000)).rejects.toThrow(
      "libsecret addon not built",
    );
  });
});
