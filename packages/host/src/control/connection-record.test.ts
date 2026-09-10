import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteHostRecord,
  hostRecordPath,
  mintControlCredential,
  mintDesktopCredential,
  readHostRecord,
  writeHostRecord,
  type HostConnectionRecordV1,
} from "./connection-record";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function dataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-record-"));
  roots.push(root);
  return root;
}

function record(root: string): HostConnectionRecordV1 {
  return {
    schemaVersion: 1,
    dataRoot: root,
    hostVersion: "1.2.3",
    hostProtocol: 2,
    protocolRange: { min: 1, max: 2 },
    endpoint: "http://127.0.0.1:43111",
    desktopCredential: mintDesktopCredential(),
    controlCredential: mintControlCredential(),
    pid: 4242,
    processStartMs: 1_700_000_000_000,
    startedAtMs: 1_700_000_000_500,
    incarnation: 3,
  };
}

describe("host connection record", () => {
  it("round-trips through <dataRoot>/host.json and deletes cleanly", () => {
    const root = dataRoot();
    const written = record(root);
    writeHostRecord(written);
    expect(hostRecordPath(root)).toBe(path.join(root, "host.json"));
    expect(readHostRecord(root)).toEqual(written);
    deleteHostRecord(root);
    expect(fs.existsSync(hostRecordPath(root))).toBe(false);
    expect(readHostRecord(root)).toBeNull();
    // Deleting an absent record is not an error: close() after a failed start must not throw.
    expect(() => deleteHostRecord(root)).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("writes the record owner-only (0600)", () => {
    const root = dataRoot();
    writeHostRecord(record(root));
    expect(fs.statSync(hostRecordPath(root)).mode & 0o777).toBe(0o600);
  });

  it("reads null for a foreign schema, a malformed file, or a mistyped field", () => {
    const root = dataRoot();
    const good = record(root);
    const file = hostRecordPath(root);

    fs.writeFileSync(file, JSON.stringify({ ...good, schemaVersion: 2 }));
    expect(readHostRecord(root)).toBeNull();

    fs.writeFileSync(file, "{not json");
    expect(readHostRecord(root)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ ...good, pid: "4242" }));
    expect(readHostRecord(root)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ ...good, protocolRange: { min: 1 } }));
    expect(readHostRecord(root)).toBeNull();

    const { endpoint: _dropped, ...missing } = good;
    fs.writeFileSync(file, JSON.stringify(missing));
    expect(readHostRecord(root)).toBeNull();
  });

  it("mints prefixed, distinct, 32-byte base64url credentials", () => {
    const desk = mintDesktopCredential();
    const ctl = mintControlCredential();
    expect(desk).toMatch(/^omp1\.desk\.[A-Za-z0-9_-]{43}$/);
    expect(ctl).toMatch(/^omp1\.ctl\.[A-Za-z0-9_-]{43}$/);
    expect(mintDesktopCredential()).not.toBe(desk);
    expect(mintControlCredential()).not.toBe(ctl);
  });
});
