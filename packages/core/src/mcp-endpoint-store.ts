import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { writeTextAtomic } from "./atomic-write";
import { MCP_CALL_LOG_MAX, isMcpClientRecord, type McpCall, type McpCallOutcome, type McpClientRecord } from "./mcp-endpoint";

/**
 * Persisted MCP clients (issue #996, ADR-0080), beside registry.json. Unlike
 * a webhook secret, omp-ui never needs a client token back: only its SHA-256
 * is stored, so the file opens nothing even when read, and no OS credential
 * store is needed. The token itself is shown once, in the create/rotate reply.
 */

interface McpClientFile {
  schemaVersion: 1;
  clients: Array<McpClientRecord & { tokenHash: string }>;
}

interface Entry {
  record: McpClientRecord;
  /** SHA-256 of the token, raw bytes. */
  hash: Buffer;
}

const HASH_HEX = /^[0-9a-f]{64}$/;

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class McpClientStore {
  private readonly entries: Entry[] = [];

  constructor(private readonly file: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return;
    }
    const clients = (parsed as Partial<McpClientFile> | null)?.clients;
    if (!Array.isArray(clients)) return;
    for (const raw of clients) {
      if (raw === null || typeof raw !== "object") continue;
      const { tokenHash: hex, ...record } = raw as McpClientRecord & { tokenHash: unknown };
      if (typeof hex !== "string" || !HASH_HEX.test(hex) || !isMcpClientRecord(record)) continue;
      if (this.entries.some((e) => e.record.id === record.id)) continue;
      this.entries.push({ record, hash: Buffer.from(hex, "hex") });
    }
  }

  /** 0600: the hashes open nothing, but the client list is still nobody else's business. */
  private save(): void {
    const data: McpClientFile = {
      schemaVersion: 1,
      clients: this.entries.map((e) => ({ ...e.record, tokenHash: e.hash.toString("hex") })),
    };
    writeTextAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  private entry(id: string): Entry {
    const found = this.entries.find((e) => e.record.id === id);
    if (!found) throw new Error(`unknown MCP client ${id}`);
    return found;
  }

  /** Records in creation order; hashes stay inside the store. */
  list(): McpClientRecord[] {
    return this.entries.map((e) => ({ ...e.record }));
  }

  get(id: string): McpClientRecord | null {
    const found = this.entries.find((e) => e.record.id === id);
    return found === undefined ? null : { ...found.record };
  }

  /**
   * The client a presented token belongs to, or null. Every entry is compared
   * with timingSafeEqual over fixed-length digests, so neither timing nor
   * length tells a caller how close a guess came.
   */
  match(token: string): McpClientRecord | null {
    if (token === "") return null;
    const given = tokenHash(token);
    let found: Entry | null = null;
    for (const e of this.entries) if (timingSafeEqual(e.hash, given) && found === null) found = e;
    return found === null ? null : { ...found.record };
  }

  add(record: McpClientRecord, token: string): void {
    if (this.entries.some((e) => e.record.id === record.id)) throw new Error(`MCP client ${record.id} already exists`);
    this.entries.push({ record: { ...record }, hash: tokenHash(token) });
    this.save();
  }

  update(id: string, patch: Partial<Omit<McpClientRecord, "id" | "createdAt">>): void {
    const entry = this.entry(id);
    entry.record = { ...entry.record, ...patch };
    this.save();
  }

  rotate(id: string, token: string): void {
    this.entry(id).hash = tokenHash(token);
    this.save();
  }

  remove(id: string): void {
    const index = this.entries.findIndex((e) => e.record.id === id);
    if (index === -1) return;
    this.entries.splice(index, 1);
    this.save();
  }
}

const OUTCOMES: readonly McpCallOutcome[] = ["ok", "refused", "forbidden", "rate-limited", "error"];

function isCall(value: unknown): value is McpCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    typeof v.clientId === "string" &&
    typeof v.clientName === "string" &&
    typeof v.remoteAddress === "string" &&
    typeof v.tool === "string" &&
    (v.target === null || typeof v.target === "string") &&
    OUTCOMES.includes(v.outcome as McpCallOutcome) &&
    (v.message === null || typeof v.message === "string") &&
    typeof v.durationMs === "number"
  );
}

/** The MCP call audit list (ADR-0080): newest last, capped, written 0600. */
export class McpCallLog {
  private entries: McpCall[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { calls?: unknown };
      if (Array.isArray(parsed.calls)) this.entries = parsed.calls.filter(isCall).slice(-MCP_CALL_LOG_MAX);
    } catch {
      // Absent or unreadable: an empty log.
    }
  }

  list(): McpCall[] {
    return this.entries.map((c) => ({ ...c }));
  }

  record(call: McpCall): void {
    this.entries.push({ ...call });
    if (this.entries.length > MCP_CALL_LOG_MAX) this.entries.splice(0, this.entries.length - MCP_CALL_LOG_MAX);
    writeTextAtomic(this.file, `${JSON.stringify({ schemaVersion: 1, calls: this.entries })}\n`, 0o600);
  }

  clear(): void {
    this.entries = [];
    writeTextAtomic(this.file, `${JSON.stringify({ schemaVersion: 1, calls: [] })}\n`, 0o600);
  }
}
