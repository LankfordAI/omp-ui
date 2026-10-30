import * as fs from "node:fs";
import { writeTextAtomic } from "./atomic-write";
import type { KeyCipher } from "./provider-keys";
import {
  WEBHOOK_DELIVERY_LOG_MAX,
  isWebhookRecord,
  type WebhookDelivery,
  type WebhookRecord,
  type WebhookSummary,
} from "./webhook";

/**
 * Persisted webhooks with their secrets (issue #997, ADR-0075), beside
 * registry.json. Follows RemoteInstanceStore: the secret is encrypted by the
 * injected KeyCipher and stored base64, never plaintext; writes are refused
 * without an OS credential store; a webhook whose blob no longer decrypts
 * stays listed with `secretReadable: false` instead of being forgotten.
 */

interface WebhookFile {
  schemaVersion: 1;
  webhooks: Array<WebhookRecord & { secret: string }>;
}

export const WEBHOOK_STORE_UNAVAILABLE =
  "omp-ui cannot store a webhook secret: no OS credential store is available on this system.";

interface Entry {
  record: WebhookRecord;
  /** Decrypted secret; null when the blob would not decrypt. */
  secret: string | null;
  blob: string;
}

export class WebhookStore {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher,
  ) {
    this.load();
  }

  get available(): boolean {
    return this.cipher.available;
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const webhooks = (parsed as Partial<WebhookFile> | null)?.webhooks;
    if (!Array.isArray(webhooks)) return;
    for (const raw of webhooks) {
      if (raw === null || typeof raw !== "object") continue;
      const { secret: blob, ...record } = raw as WebhookRecord & { secret: unknown };
      if (typeof blob !== "string" || !isWebhookRecord(record)) continue;
      if (this.entries.some((e) => e.record.id === record.id)) continue;
      let secret: string | null = null;
      try {
        const value = this.cipher.decrypt(Buffer.from(blob, "base64"));
        secret = value === "" ? null : value;
      } catch {
        // Wrong keyring, rotated master key, or a truncated file: kept, flagged.
      }
      this.entries.push({ record, secret, blob });
    }
  }

  /** 0600 — the file holds secrets even when the cipher is only obfuscation. */
  private save(): void {
    const data: WebhookFile = {
      schemaVersion: 1,
      webhooks: this.entries.map((e) => ({ ...e.record, secret: e.blob })),
    };
    writeTextAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  private encrypt(secret: string): string {
    if (!this.cipher.available) throw new Error(WEBHOOK_STORE_UNAVAILABLE);
    return this.cipher.encrypt(secret).toString("base64");
  }

  private entry(id: string): Entry {
    const found = this.entries.find((e) => e.record.id === id);
    if (!found) throw new Error(`unknown webhook ${id}`);
    return found;
  }

  /** Records in creation order; secrets stay inside the store. */
  list(): WebhookSummary[] {
    return this.entries.map((e) => ({ ...e.record, secretReadable: e.secret !== null }));
  }

  get(id: string): WebhookRecord | null {
    const found = this.entries.find((e) => e.record.id === id);
    return found === undefined ? null : { ...found.record };
  }

  /** Decrypted secret, or null for an unknown id or an unreadable blob. */
  secret(id: string): string | null {
    return this.entries.find((e) => e.record.id === id)?.secret ?? null;
  }

  add(record: WebhookRecord, secret: string): void {
    if (this.entries.some((e) => e.record.id === record.id)) throw new Error(`webhook ${record.id} already exists`);
    const blob = this.encrypt(secret);
    this.entries.push({ record: { ...record }, secret, blob });
    this.save();
  }

  update(id: string, patch: Partial<Omit<WebhookRecord, "id" | "createdAt">>): void {
    const entry = this.entry(id);
    entry.record = { ...entry.record, ...patch };
    this.save();
  }

  rotate(id: string, secret: string): void {
    const entry = this.entry(id);
    entry.blob = this.encrypt(secret);
    entry.secret = secret;
    this.save();
  }

  remove(id: string): void {
    const index = this.entries.findIndex((e) => e.record.id === id);
    if (index === -1) return;
    this.entries.splice(index, 1);
    this.save();
  }
}

function isDelivery(value: unknown): value is WebhookDelivery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    typeof v.webhookId === "string" &&
    typeof v.webhookName === "string" &&
    typeof v.remoteAddress === "string" &&
    (v.event === null || typeof v.event === "string") &&
    typeof v.bytes === "number" &&
    typeof v.status === "number" &&
    typeof v.outcome === "string" &&
    (v.tabId === null || typeof v.tabId === "string") &&
    typeof v.machineKey === "string" &&
    (v.message === null || typeof v.message === "string")
  );
}

/**
 * The delivery audit list (ADR-0075): newest last, capped, written 0600.
 * A delivery still `pending` when the app quit can never be learned, so it
 * loads as `unknown`.
 */
export class WebhookDeliveryLog {
  private entries: WebhookDelivery[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { deliveries?: unknown };
      if (Array.isArray(parsed.deliveries)) {
        this.entries = parsed.deliveries
          .filter(isDelivery)
          .slice(-WEBHOOK_DELIVERY_LOG_MAX)
          .map((d) => (d.outcome === "pending" ? { ...d, outcome: "unknown", message: "omp-ui quit before the outcome was known" } : d));
      }
    } catch {
      // Absent or unreadable: an empty log.
    }
  }

  list(): WebhookDelivery[] {
    return this.entries.map((d) => ({ ...d }));
  }

  record(delivery: WebhookDelivery): void {
    this.entries.push({ ...delivery });
    if (this.entries.length > WEBHOOK_DELIVERY_LOG_MAX) this.entries.splice(0, this.entries.length - WEBHOOK_DELIVERY_LOG_MAX);
    this.save();
  }

  update(id: string, patch: Partial<Pick<WebhookDelivery, "outcome" | "tabId" | "message" | "status">>): void {
    const index = this.entries.findIndex((d) => d.id === id);
    if (index === -1) return;
    this.entries[index] = { ...this.entries[index]!, ...patch };
    this.save();
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  private save(): void {
    writeTextAtomic(this.file, `${JSON.stringify({ schemaVersion: 1, deliveries: this.entries })}\n`, 0o600);
  }
}
