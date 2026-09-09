import * as fs from "node:fs";
import { writeTextAtomic } from "./atomic-write";
import type { KeyCipher } from "./provider-keys";
import type { RemoteInstanceRecord } from "./remote-instances";

/**
 * Persisted joined-instance records with their credentials (issue #416),
 * beside registry.json. Follows ProviderKeys: the credential is encrypted by
 * the injected KeyCipher and stored base64, never plaintext; an entry whose
 * blob no longer decrypts stays listed so the manager can report it as
 * needing a fresh sign-in instead of silently forgetting the instance.
 */

/** On-disk shape; `credential` is base64 of the KeyCipher blob, never plaintext. */
interface RemoteInstanceFile {
  schemaVersion: 1;
  instances: Array<RemoteInstanceRecord & { credential: string }>;
}

export const REMOTE_INSTANCE_STORE_UNAVAILABLE =
  "omp-ui cannot store the credential: no OS credential store is available on this system.";

interface Entry {
  record: RemoteInstanceRecord;
  /** Decrypted credential; null when the blob would not decrypt. */
  credential: string | null;
  /** The blob as loaded, kept so a nickname rename never rewrites an undecryptable credential. */
  blob: string;
}

function isStoredInstance(value: unknown): value is RemoteInstanceRecord & { credential: string } {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.nickname === "string" &&
    typeof v.url === "string" &&
    typeof v.addedAt === "string" &&
    typeof v.credential === "string"
  );
}

export class RemoteInstanceStore {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher,
  ) {
    this.load();
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const instances = (parsed as Partial<RemoteInstanceFile>).instances;
    if (!Array.isArray(instances)) return;
    for (const raw of instances) {
      if (!isStoredInstance(raw)) continue;
      const { credential: blob, ...record } = raw;
      let credential: string | null = null;
      try {
        const value = this.cipher.decrypt(Buffer.from(blob, "base64"));
        credential = value === "" ? null : value;
      } catch {
        // Wrong keyring, rotated master key, or a truncated file: kept, flagged.
      }
      this.entries.push({ record, credential, blob });
    }
  }

  /** 0600 — the file holds credentials even when the cipher is only obfuscation. */
  private save(): void {
    const data: RemoteInstanceFile = {
      schemaVersion: 1,
      instances: this.entries.map((e) => ({ ...e.record, credential: e.blob })),
    };
    writeTextAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  private encrypt(credential: string): string {
    if (!this.cipher.available) throw new Error(REMOTE_INSTANCE_STORE_UNAVAILABLE);
    return this.cipher.encrypt(credential).toString("base64");
  }

  private entry(id: string): Entry {
    const found = this.entries.find((e) => e.record.id === id);
    if (!found) throw new Error(`unknown instance ${id}`);
    return found;
  }

  /** Records in persisted order; credentials stay inside the store. */
  list(): RemoteInstanceRecord[] {
    return this.entries.map((e) => ({ ...e.record }));
  }

  /** Decrypted credential, or null when the blob would not decrypt (entry kept, flagged). */
  credential(id: string): string | null {
    return this.entries.find((e) => e.record.id === id)?.credential ?? null;
  }

  add(record: RemoteInstanceRecord, credential: string): void {
    if (this.entries.some((e) => e.record.id === record.id)) {
      throw new Error(`instance ${record.id} already exists`);
    }
    const blob = this.encrypt(credential);
    this.entries.push({ record: { ...record }, credential, blob });
    this.save();
  }

  update(id: string, patch: { nickname?: string; url?: string; credential?: string }): void {
    const entry = this.entry(id);
    if (patch.credential !== undefined) {
      entry.blob = this.encrypt(patch.credential);
      entry.credential = patch.credential;
    }
    if (patch.nickname !== undefined) entry.record = { ...entry.record, nickname: patch.nickname };
    if (patch.url !== undefined) entry.record = { ...entry.record, url: patch.url };
    this.save();
  }

  remove(id: string): void {
    const index = this.entries.findIndex((e) => e.record.id === id);
    if (index === -1) return;
    this.entries.splice(index, 1);
    this.save();
  }
}
