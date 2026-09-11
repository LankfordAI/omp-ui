import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityConflict, type ClaimedAuthority } from "./authority/authority";
import { ChildrenLedger, LedgerUnresolved } from "./authority/children-ledger";
import { isHostEnvelope, openHostKeyCipher, type KeyProtector } from "./credentials/host-key-cipher";
import { MigrationJournal, type ItemEvidence } from "./migration/journal";
import { serve, type ServeDeps } from "./serve";

/**
 * The boot order's failure exits, with every process-touching seam faked:
 * the claim, the ledger, and the DEK protector. Nothing here binds a port or
 * spawns a child; `serve.live.test.ts` proves the real composition.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-serve-"));
  roots.push(root);
  return root;
}

function memoryProtector(initial: Buffer = randomBytes(32)): KeyProtector {
  let stored: Buffer | null = initial;
  return {
    backend: "memory",
    load: async () => stored,
    store: async (dek) => {
      stored = dek;
    },
  };
}

function linuxV11(password: string, plain: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v11"), cipher.update(plain, "utf8"), cipher.final()]);
}

function seedCommittedRelocation(root: string, legacy: string): MigrationJournal {
  const journal = MigrationJournal.open(root, { now: () => 1_700_000_000_000 });
  journal.begin("relocate-authority-stores-v1");
  const evidence = (name: string): ItemEvidence => ({
    name,
    source: path.join(legacy, name),
    destination: path.join(root, name),
    mode: 0o600,
    size: 1,
    mtimeMs: 1,
    dev: 1,
    ino: 1,
    status: "done",
  });
  journal.updateItem("relocate-authority-stores-v1", evidence("provider-keys.json"));
  journal.updateItem("relocate-authority-stores-v1", evidence("registry.json"));
  journal.commit("relocate-authority-stores-v1");
  journal.begin("credential-handoff-v1");
  return journal;
}

interface Harness {
  root: string;
  log: string[];
  released: number;
  deps: ServeDeps;
}

function harness(over: Partial<ServeDeps> = {}): Harness {
  const root = tempRoot();
  const log: string[] = [];
  const h: Harness = {
    root,
    log,
    released: 0,
    deps: {
      claim: async (dataRoot): Promise<ClaimedAuthority> => ({
        dataRoot,
        incarnation: 7,
        release: () => {
          h.released += 1;
        },
      }),
      ledger: (dataRoot, deps) => new ChildrenLedger(dataRoot, deps),
      protector: () => memoryProtector(),
      probe: async () => false,
      now: () => 1_700_000_000_000,
      ...over,
    },
  };
  return h;
}

function run(h: Harness): Promise<number> {
  return serve({
    dataRoot: h.root,
    hostVersion: "0.0.0-test",
    flavor: "dev",
    webRoot: "",
    verifier: null,
    signals: new EventEmitter(),
    log: (line) => h.log.push(line),
    deps: h.deps,
  });
}

describe("serve boot order", () => {
  it("exits 5 on an authority conflict without touching the root", async () => {
    const h = harness({
      claim: async () => {
        throw new AuthorityConflict("owner alive", null, null);
      },
    });
    await expect(run(h)).resolves.toBe(5);
    expect(h.released).toBe(0);
    expect(fs.existsSync(path.join(h.root, "registry.json"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, "host.json"))).toBe(false);
    expect(h.log.some((line) => line.startsWith("authority conflict"))).toBe(true);
  });

  it("exits 1 and releases the token when a previous host's child cannot be proven dead", async () => {
    const h = harness({
      ledger: (dataRoot, deps) => {
        const ledger = new ChildrenLedger(dataRoot, deps);
        ledger.reconcileBeforeLoad = async () => {
          throw new LedgerUnresolved([4242]);
        };
        return ledger;
      },
    });
    await expect(run(h)).resolves.toBe(1);
    expect(h.released).toBe(1);
    // The registry is never reached: nothing was loaded or created.
    expect(fs.existsSync(path.join(h.root, "registry.json"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, "host.json"))).toBe(false);
    expect(h.log.some((line) => line.includes("pid 4242"))).toBe(true);
  });

  it("exits 1 on a corrupt registry, leaves it in place, and quarantines nothing", async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.root, "registry.json"), "{not json");
    await expect(run(h)).resolves.toBe(1);
    expect(h.released).toBe(1);
    expect(fs.readFileSync(path.join(h.root, "registry.json"), "utf8")).toBe("{not json");
    expect(fs.readdirSync(h.root).filter((name) => name.includes(".corrupt-"))).toEqual([]);
    expect(fs.existsSync(path.join(h.root, "host.json"))).toBe(false);
    expect(h.log.some((line) => line.includes("nothing was moved"))).toBe(true);
  });
});

describe.runIf(process.platform === "linux")("v0.11.0 Linux credential recovery", () => {
  it("uses relocation evidence and a later Secret Service candidate to complete handoff", async () => {
    const dek = randomBytes(32);
    const password = "legacy-safe-storage-password";
    const original = "sk-or-v1-original";
    const h = harness({
      protector: () => memoryProtector(dek),
      lookupLinuxSecretServiceMany: async () => [Buffer.from(password)],
    } as Partial<ServeDeps>);
    const legacy = tempRoot();
    seedCommittedRelocation(h.root, legacy);
    fs.writeFileSync(
      path.join(h.root, "provider-keys.json"),
      JSON.stringify({ schemaVersion: 1, keys: { OPENROUTER_API_KEY: linuxV11(password, original).toString("base64") } }),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(h.root, "registry.json"), "{not json");

    await expect(run(h)).resolves.toBe(1);

    const stored = Buffer.from(JSON.parse(fs.readFileSync(path.join(h.root, "provider-keys.json"), "utf8")).keys.OPENROUTER_API_KEY, "base64");
    expect(isHostEnvelope(stored)).toBe(true);
    const cipher = await openHostKeyCipher(memoryProtector(dek), { hasCiphertext: true });
    expect(cipher.decrypt(stored)).toBe(original);
    expect(MigrationJournal.open(h.root, { now: () => 2 }).step("credential-handoff-v1")?.status).toBe("committed");
  });

  it("preserves identical bytes and retries when legacy Secret Service is unavailable", async () => {
    const dek = randomBytes(32);
    let lookups = 0;
    const h = harness({
      protector: () => memoryProtector(dek),
      lookupLinuxSecretServiceMany: async () => {
        lookups += 1;
        throw new Error("collection locked");
      },
    } as Partial<ServeDeps>);
    const legacy = tempRoot();
    seedCommittedRelocation(h.root, legacy);
    const original = linuxV11("unavailable", "sk-or-v1-preserved");
    fs.writeFileSync(
      path.join(h.root, "provider-keys.json"),
      JSON.stringify({ schemaVersion: 1, keys: { OPENROUTER_API_KEY: original.toString("base64") } }),
      { mode: 0o600 },
    );
    const before = fs.readFileSync(path.join(h.root, "provider-keys.json"));
    fs.writeFileSync(path.join(h.root, "registry.json"), "{not json");

    await expect(run(h)).resolves.toBe(1);

    expect(lookups).toBe(1);
    expect(fs.readFileSync(path.join(h.root, "provider-keys.json")).equals(before)).toBe(true);
    expect(MigrationJournal.open(h.root, { now: () => 2 }).step("credential-handoff-v1")?.status).toBe("open");
  });
});
