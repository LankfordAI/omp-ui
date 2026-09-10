import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_BREADCRUMBS, RemoteInstanceStore, type BreadcrumbEntry, type BreadcrumbSink, type KeyCipher } from "@omp-ui/core";
import { handoffCredentials, type ElectronBlobReader } from "./credential-handoff";
import { MigrationJournal } from "./journal";

const dirs: string[] = [];

function dataRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-handoff-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the 0x02 host cipher: version byte, then the bytes. */
const hostCipher: KeyCipher = {
  available: true,
  backend: "test",
  encrypt: (plain) => Buffer.concat([Buffer.from([0x02]), Buffer.from(plain, "utf8")]),
  decrypt: (blob) => {
    if (blob[0] !== 0x02) throw new Error("not a host envelope");
    return blob.subarray(1).toString("utf8");
  },
};
const isHostEnvelope = (blob: Buffer): boolean => blob[0] === 0x02;

/** "Electron" blobs: `E:` + plaintext; `L:` locked; anything else foreign. */
const electron = (plain: string): string => Buffer.from(`E:${plain}`).toString("base64");
const LOCKED = Buffer.from("L:").toString("base64");
const FOREIGN = Buffer.from("v99 who knows").toString("base64");
const read: ElectronBlobReader = (blob) => {
  const text = blob.toString("utf8");
  if (text.startsWith("E:")) return text.slice(2);
  if (text.startsWith("L:")) return "locked";
  return "foreign";
};

function recording(): BreadcrumbSink & { details: string[] } {
  const entries: BreadcrumbEntry[] = [];
  return {
    details: [],
    record(kind, fields) {
      entries.push({ at: "", seq: entries.length, kind, ...fields });
      this.details.push(`${kind}: ${fields?.detail ?? ""}`);
    },
    entries: () => entries,
  };
}

function run(root: string, breadcrumbs: BreadcrumbSink = NO_BREADCRUMBS) {
  return handoffCredentials({
    dataRoot: root,
    journal: MigrationJournal.open(root, { now: () => 1 }),
    read,
    encrypt: hostCipher.encrypt,
    isHostEnvelope,
    breadcrumbs,
  });
}

function providerKeys(root: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(root, "provider-keys.json"), "utf8")).keys;
}

describe("handoffCredentials", () => {
  it("re-encrypts provider keys, keeps host envelopes, drops foreign ones, and commits", async () => {
    const root = dataRoot();
    const already = hostCipher.encrypt("already-host").toString("base64");
    fs.writeFileSync(
      path.join(root, "provider-keys.json"),
      JSON.stringify({
        schemaVersion: 1,
        keys: { OPENAI_API_KEY: electron("sk-openai"), ANTHROPIC_API_KEY: already, GEMINI_API_KEY: FOREIGN },
      }),
    );
    const breadcrumbs = recording();
    expect(await run(root, breadcrumbs)).toEqual({ complete: true });

    const keys = providerKeys(root);
    expect(Object.keys(keys).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(hostCipher.decrypt(Buffer.from(keys.OPENAI_API_KEY, "base64"))).toBe("sk-openai");
    expect(keys.ANTHROPIC_API_KEY).toBe(already);
    expect(fs.statSync(path.join(root, "provider-keys.json")).mode & 0o777).toBe(0o600);
    expect(breadcrumbs.details.some((d) => d.startsWith("credentials:") && d.includes("dropped GEMINI_API_KEY"))).toBe(true);
    expect(MigrationJournal.open(root, { now: () => 2 }).step("credential-handoff-v1")?.status).toBe("committed");
  });

  it("leaves locked blobs byte-for-byte, converts the rest, and keeps the step open", async () => {
    const root = dataRoot();
    fs.writeFileSync(
      path.join(root, "provider-keys.json"),
      JSON.stringify({ schemaVersion: 1, keys: { OPENAI_API_KEY: LOCKED, ANTHROPIC_API_KEY: electron("sk-ant") } }),
    );
    expect(await run(root)).toEqual({ complete: false });
    const keys = providerKeys(root);
    expect(keys.OPENAI_API_KEY).toBe(LOCKED);
    expect(hostCipher.decrypt(Buffer.from(keys.ANTHROPIC_API_KEY, "base64"))).toBe("sk-ant");
    const step = MigrationJournal.open(root, { now: () => 2 }).step("credential-handoff-v1");
    expect(step?.status).toBe("open");
    expect(step?.items.find((i) => i.name === "provider-keys.json")?.status).toBe("pending");

    // A later run with the keyring unlocked finishes the job.
    fs.writeFileSync(
      path.join(root, "provider-keys.json"),
      JSON.stringify({ schemaVersion: 1, keys: { ...keys, OPENAI_API_KEY: electron("sk-openai") } }),
    );
    expect(await run(root)).toEqual({ complete: true });
    expect(hostCipher.decrypt(Buffer.from(providerKeys(root).OPENAI_API_KEY, "base64"))).toBe("sk-openai");
  });

  it("re-encrypts remote instance credentials and marks foreign ones as needing sign-in", async () => {
    const root = dataRoot();
    const file = path.join(root, "remote-instances.json");
    const base = { nickname: "n", url: "http://h:1", addedAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        instances: [
          { id: "a", ...base, credential: electron("omp1.remote.aaa") },
          { id: "b", ...base, credential: FOREIGN },
          { id: "c", ...base, credential: hostCipher.encrypt("omp1.remote.ccc").toString("base64") },
        ],
      }),
    );
    const breadcrumbs = recording();
    expect(await run(root, breadcrumbs)).toEqual({ complete: true });

    // The host's own store is the consumer: a converted credential reads back,
    // a foreign one keeps its record but reports "needs sign-in" (null).
    const store = new RemoteInstanceStore(file, hostCipher);
    expect(store.list().map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(store.credential("a")).toBe("omp1.remote.aaa");
    expect(store.credential("b")).toBeNull();
    expect(store.credential("c")).toBe("omp1.remote.ccc");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(breadcrumbs.details.some((d) => d.includes("instance b needs a fresh sign-in"))).toBe(true);
  });

  it("a locked instance credential keeps the step open without touching the record", async () => {
    const root = dataRoot();
    const file = path.join(root, "remote-instances.json");
    const record = { id: "a", nickname: "n", url: "http://h:1", addedAt: "t", credential: LOCKED };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, instances: [record] }));
    expect(await run(root)).toEqual({ complete: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).instances).toEqual([record]);
  });

  it("skips absent stores and is a no-op once committed", async () => {
    const root = dataRoot();
    expect(await run(root)).toEqual({ complete: true });
    const journal = MigrationJournal.open(root, { now: () => 2 });
    expect(journal.step("credential-handoff-v1")?.items.map((i) => [i.name, i.status])).toEqual([
      ["provider-keys.json", "skipped"],
      ["remote-instances.json", "skipped"],
    ]);
    fs.writeFileSync(
      path.join(root, "provider-keys.json"),
      JSON.stringify({ schemaVersion: 1, keys: { OPENAI_API_KEY: FOREIGN } }),
    );
    expect(await run(root)).toEqual({ complete: true });
    expect(providerKeys(root).OPENAI_API_KEY).toBe(FOREIGN);
  });
});
