import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably, type BreadcrumbSink } from "@omp-ui/core";
import type { MigrationJournal } from "./journal";

/**
 * Re-encrypts the credential stores from Electron's safeStorage envelopes to
 * the host's own cipher (issue #442, WP7 §10.2). Runs after
 * {@link relocateAuthorityStores}, on the files already inside the data root.
 *
 * Per stored value: a host envelope is left alone; plaintext the Electron
 * reader recovers is re-encrypted; a "locked" blob (keyring or Keychain not
 * readable right now) is left byte-for-byte and keeps the step open so a
 * later run retries; a "foreign" blob (not safeStorage's, or another
 * account's) can never be recovered — a provider key is dropped, a remote
 * instance keeps its record and is marked as needing a fresh sign-in.
 */

/** Plaintext, or why the blob could not be read: retry later vs. never. */
export type ElectronBlobReader = (blob: Buffer) => string | "locked" | "foreign";

const STEP = "credential-handoff-v1";

export interface CredentialHandoffOptions {
  dataRoot: string;
  journal: MigrationJournal;
  read: ElectronBlobReader;
  /** The host cipher's encrypt (0x02 envelope). */
  encrypt: (plain: string) => Buffer;
  isHostEnvelope: (blob: Buffer) => boolean;
  breadcrumbs: BreadcrumbSink;
}

interface Conversion {
  /** New base64 blob; null means "remove this credential". */
  value: string | null;
  outcome: "kept" | "converted" | "locked" | "foreign";
}

function convert(base64: string, opts: CredentialHandoffOptions): Conversion {
  const blob = Buffer.from(base64, "base64");
  if (opts.isHostEnvelope(blob)) return { value: base64, outcome: "kept" };
  const plain = opts.read(blob);
  if (plain === "locked") return { value: base64, outcome: "locked" };
  if (plain === "foreign") return { value: null, outcome: "foreign" };
  return { value: opts.encrypt(plain).toString("base64"), outcome: "converted" };
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function recordFile(opts: CredentialHandoffOptions, file: string, status: "pending" | "done" | "skipped"): void {
  const name = path.basename(file);
  if (status === "skipped") {
    opts.journal.updateItem(STEP, {
      name,
      source: file,
      destination: file,
      mode: 0,
      size: 0,
      mtimeMs: 0,
      dev: 0,
      ino: 0,
      status,
    });
    return;
  }
  const st = fs.statSync(file);
  opts.journal.updateItem(STEP, {
    name,
    source: file,
    destination: file,
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
    dev: st.dev,
    ino: st.ino,
    status,
  });
}

/** `{ schemaVersion: 1, keys: Record<envName, base64> }` — foreign keys are dropped. */
function handoffProviderKeys(opts: CredentialHandoffOptions): boolean {
  const file = path.join(opts.dataRoot, "provider-keys.json");
  const raw = readJson(file);
  if (raw === undefined) {
    recordFile(opts, file, "skipped");
    return true;
  }
  if (raw === null || typeof raw !== "object" || !("keys" in raw) || raw.keys === null || typeof raw.keys !== "object") {
    opts.breadcrumbs.record("credentials", { detail: "migration: provider-keys.json has no keys object; left as is" });
    recordFile(opts, file, "done");
    return true;
  }
  const keys = raw.keys as Record<string, unknown>; // validated object above; values checked per entry below
  let complete = true;
  let changed = false;
  for (const [name, value] of Object.entries(keys)) {
    if (typeof value !== "string") continue;
    const result = convert(value, opts);
    if (result.outcome === "kept") continue;
    if (result.outcome === "locked") {
      complete = false;
      opts.breadcrumbs.record("credentials", { detail: `migration: ${name} is locked; will retry` });
      continue;
    }
    changed = true;
    if (result.value === null) {
      delete keys[name];
      opts.breadcrumbs.record("credentials", { detail: `migration: dropped ${name}: not a safeStorage blob this account can read` });
    } else {
      keys[name] = result.value;
    }
  }
  if (changed) writeTextDurably(file, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
  recordFile(opts, file, complete ? "done" : "pending");
  return complete;
}

/**
 * `{ schemaVersion: 1, instances: [{ id, nickname, url, addedAt, credential: base64 }] }`.
 * A foreign credential becomes the host encryption of "" — which
 * `RemoteInstanceStore.load` reads as `credential: null`, its own
 * "needs a fresh sign-in" state — so the record stays listed.
 */
function handoffRemoteInstances(opts: CredentialHandoffOptions): boolean {
  const file = path.join(opts.dataRoot, "remote-instances.json");
  const raw = readJson(file);
  if (raw === undefined) {
    recordFile(opts, file, "skipped");
    return true;
  }
  if (raw === null || typeof raw !== "object" || !("instances" in raw) || !Array.isArray(raw.instances)) {
    opts.breadcrumbs.record("credentials", { detail: "migration: remote-instances.json has no instances array; left as is" });
    recordFile(opts, file, "done");
    return true;
  }
  let complete = true;
  let changed = false;
  for (const instance of raw.instances as unknown[]) {
    if (instance === null || typeof instance !== "object" || !("credential" in instance)) continue;
    if (typeof instance.credential !== "string") continue;
    const label = "id" in instance && typeof instance.id === "string" ? instance.id : "?";
    const result = convert(instance.credential, opts);
    if (result.outcome === "kept") continue;
    if (result.outcome === "locked") {
      complete = false;
      opts.breadcrumbs.record("credentials", { detail: `migration: instance ${label} credential is locked; will retry` });
      continue;
    }
    changed = true;
    if (result.value === null) {
      instance.credential = opts.encrypt("").toString("base64");
      opts.breadcrumbs.record("credentials", {
        detail: `migration: instance ${label} needs a fresh sign-in: credential was not a readable safeStorage blob`,
      });
    } else {
      instance.credential = result.value;
    }
  }
  if (changed) writeTextDurably(file, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
  recordFile(opts, file, complete ? "done" : "pending");
  return complete;
}

export async function handoffCredentials(opts: CredentialHandoffOptions): Promise<{ complete: boolean }> {
  if (opts.journal.step(STEP)?.status === "committed") return { complete: true };
  opts.journal.begin(STEP);
  const providers = handoffProviderKeys(opts);
  const instances = handoffRemoteInstances(opts);
  const complete = providers && instances;
  if (complete) {
    opts.journal.commit(STEP);
    opts.breadcrumbs.record("credentials", { detail: "migration: credential handoff committed" });
  }
  return { complete };
}
