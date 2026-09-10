import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityConflict, type ClaimedAuthority } from "./authority/authority";
import { ChildrenLedger, LedgerUnresolved } from "./authority/children-ledger";
import type { KeyProtector } from "./credentials/host-key-cipher";
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

function memoryProtector(): KeyProtector {
  let stored: Buffer | null = randomBytes(32);
  return {
    backend: "memory",
    load: async () => stored,
    store: async (dek) => {
      stored = dek;
    },
  };
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
