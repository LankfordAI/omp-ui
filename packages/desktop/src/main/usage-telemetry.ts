import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { telemetryModelDimensions, type TelemetryModelUsageRow } from "@omp-ui/core";

// Public, write-only project token, deliberately embedded in the shipped app.
const PROJECT_TOKEN = "phc_m8Jz47vWuxxeWrD65An6cW8rsE9tvoYfxsBsxbnVMzXY";
const INGESTION_URL = "https://us.i.posthog.com/batch/";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActivityReport {
  uuid: string;
  date: string;
  timestamp: number;
}
interface ModelReport {
  uuid: string;
  bucket: string;
  provider: string;
  model: string;
  requests: number;
}
interface ModelSnapshot {
  /** Daily only while draining a frozen pre-upgrade snapshot. */
  cadence: "daily" | "hourly";
  until: number;
  rows: ModelReport[];
}
interface TelemetryLedger {
  version: 2;
  installationId: string;
  app: { lastHour: number | null; pending: ActivityReport | null };
  models: {
    since: number;
    through: number;
    pending: ModelSnapshot | null;
  } | null;
}

export interface UsageTelemetryDependencies {
  /** False in development and tests unless a caller explicitly supplies an isolated transport. */
  enabled: boolean;
  ledgerFile: string;
  appVersion: string;
  modelUsageEnabled: () => boolean;
  /** Desktop foreground use, not background fleet/process uptime. */
  isActive: () => boolean;
  /** null means unavailable/still collecting: do not advance the checkpoint. */
  readModels: (since: number, until: number) => Promise<TelemetryModelUsageRow[] | null>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Constructor-only seam for a local smoke receiver; never renderer/config controlled. */
  ingestionUrl?: string;
  projectToken?: string;
}

function day(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
function hour(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}
function isHour(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && day(Date.parse(value)) === value;
}
function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Parse only the private ledger schema. Never replay arbitrary persisted event properties. */
function readLedger(file: string): { ledger: TelemetryLedger; migrated: boolean } | null {
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
    const raw = object(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!raw || (raw.version !== 1 && raw.version !== 2) || !isUuid(raw.installationId)) return null;
    const migrated = raw.version === 1;
    const ledger: TelemetryLedger = {
      version: 2, installationId: raw.installationId,
      app: { lastHour: null, pending: null }, models: null,
    };
    if (raw.app !== null) {
      const app = object(raw.app);
      if (!app) return null;
      if (migrated) {
        if (app.lastDay !== null && !isDay(app.lastDay)) return null;
        // A daily checkpoint has no hour. Start hourly activity on the next
        // foreground observation; never invent historical hourly heartbeats.
      } else {
        if (app.lastHour !== null && (!isTime(app.lastHour) || app.lastHour % HOUR_MS !== 0)) return null;
        ledger.app.lastHour = app.lastHour as number | null;
      }
      if (app.pending !== null) {
        const report = object(app.pending);
        if (!report || !isUuid(report.uuid) || !isDay(report.date) || !isTime(report.timestamp) ||
          day(report.timestamp) !== report.date) return null;
        ledger.app.pending = { uuid: report.uuid, date: report.date, timestamp: report.timestamp };
      }
    }
    if (raw.models !== null) {
      const models = object(raw.models);
      if (!models || !isTime(models.since) || !isTime(models.through) || models.through < models.since) return null;
      ledger.models = { since: models.since, through: models.through, pending: null };
      if (models.pending !== null) {
        const pending = object(models.pending);
        if (!pending) return null;
        const cadence = migrated ? "daily" : pending.cadence;
        if (cadence !== "daily" && cadence !== "hourly") return null;
        const interval = cadence === "daily" ? DAY_MS : HOUR_MS;
        if (!isTime(pending.until) || pending.until <= models.through ||
          pending.until % interval !== 0 || !Array.isArray(pending.rows)) return null;
        const rows: ModelReport[] = [];
        for (const value of pending.rows) {
          const row = object(value);
          if (!row) return null;
          const bucket = migrated ? row.date : row.bucket;
          if (typeof bucket !== "string" || !isUuid(row.uuid) ||
            !(cadence === "daily" ? isDay(bucket) : isHour(bucket)) ||
            typeof row.provider !== "string" || typeof row.model !== "string" ||
            typeof row.requests !== "number" || !Number.isSafeInteger(row.requests) || row.requests <= 0 ||
            Date.parse(bucket) < Math.floor(models.through / interval) * interval ||
            Date.parse(bucket) >= pending.until) return null;
          const dimensions = telemetryModelDimensions(row.provider, row.model);
          if (dimensions.provider !== row.provider || dimensions.model !== row.model) return null;
          rows.push({ uuid: row.uuid, bucket, ...dimensions, requests: row.requests });
        }
        ledger.models.pending = { cadence, until: pending.until, rows };
      }
    }
    return { ledger, migrated };
  } catch {
    // A missing/corrupt ledger starts fresh; optional model history is never backfilled.
    return null;
  }
}

/** One main-process owner, required activity and optional model usage, durable report identities. */
export class UsageTelemetry {
  private ledger: TelemetryLedger | null = null;
  private loaded = false;
  private dirty = false;
  private disposed = false;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private request: AbortController | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly commonProperties: Record<string, string | boolean>;

  constructor(private readonly deps: UsageTelemetryDependencies) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.commonProperties = {
      app_version: deps.appVersion,
      os: process.platform,
      arch: process.arch,
      release_channel: deps.appVersion.includes("-nightly.") ? "nightly" : "stable",
      $process_person_profile: false,
    };
  }

  start(): void {
    this.syncConsent();
  }

  /** Called synchronously after the registry commit, before its async broadcast. */
  syncConsent(): void {
    if (!this.deps.enabled || this.disposed) return;
    const modelsEnabled = this.deps.modelUsageEnabled();
    if (!this.loaded) {
      this.loaded = true;
      const restored = readLedger(this.deps.ledgerFile);
      this.ledger = restored?.ledger ?? null;
      this.dirty = restored?.migrated ?? false;
    }
    const now = this.now();
    if (!this.ledger) {
      this.ledger = {
        version: 2, installationId: randomUUID(), app: { lastHour: null, pending: null },
        models: modelsEnabled ? { since: now, through: now, pending: null } : null,
      };
      this.dirty = true;
    }
    const ledger = this.ledger;
    if ((ledger.models !== null) !== modelsEnabled) {
      this.generation++;
      this.request?.abort();
      ledger.models = modelsEnabled ? { since: now, through: now, pending: null } : null;
      this.dirty = true;
    }
    // Persist the installation identity and model-sharing start time before sending.
    try { this.save(); } catch { this.warn(); }
    void this.poll();
  }

  /** Focus calls this too; single-flight prevents duplicate renderer/focus/timer sends. */
  poll(): Promise<void> {
    if (!this.deps.enabled || this.disposed || !this.ledger) return Promise.resolve();
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = this.run(generation).catch(() => this.warn()).finally(() => {
      this.running = null;
      if (this.disposed || !this.ledger) return;
      clearTimeout(this.timer);
      if (generation !== this.generation) queueMicrotask(() => void this.poll());
      else {
        this.timer = setTimeout(() => void this.poll(), POLL_MS);
        this.timer.unref?.();
      }
    });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.request?.abort();
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.ledger !== null;
  }

  private save(): void {
    if (!this.dirty || !this.ledger) return;
    const file = this.deps.ledgerFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.ledger), { mode: 0o600 });
      fs.renameSync(temporary, file);
      this.dirty = false;
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort for our own temp file. */ }
    }
  }


  private async send(batch: unknown[], generation: number): Promise<boolean> {
    if (!this.current(generation)) return false;
    this.save();
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.deps.ingestionUrl ?? INGESTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.deps.projectToken ?? PROJECT_TOKEN, batch }),
        signal: controller.signal,
        redirect: "error",
      });
      // Drain without retaining/logging any provider response body.
      await response.body?.cancel();
      return response.ok && this.current(generation);
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) this.request = null;
    }
  }

  private async run(generation: number): Promise<void> {
    this.save();
    const ledger = this.ledger!;
    const app = ledger.app;
    const now = this.now();
    const currentHour = hour(now);
    if (!app.pending && (app.lastHour === null || app.lastHour < currentHour) && this.deps.isActive()) {
      app.pending = { uuid: randomUUID(), date: day(now), timestamp: now };
      this.dirty = true;
    }
    if (app.pending) {
      const report = app.pending;
      const accepted = await this.send([{
        uuid: report.uuid,
        event: "app_active",
        distinct_id: ledger.installationId,
        timestamp: new Date(report.timestamp).toISOString(),
        properties: { ...this.commonProperties, date: report.date },
      }], generation);
      if (!this.current(generation)) return;
      if (accepted) {
        app.lastHour = hour(report.timestamp);
        app.pending = null;
        this.dirty = true;
        this.save();
      }
    }
    if (!this.current(generation)) return;
    const models = ledger.models;
    if (!models) return;
    const until = hour(this.now());
    if (!models.pending && models.through < until) {
      const rows = await this.deps.readModels(models.through, until);
      if (!this.current(generation) || rows === null) return;
      const grouped = new Map<string, ModelReport>();
      for (const row of rows) {
        if (!isHour(row.hour) || Date.parse(row.hour) < hour(models.through) || Date.parse(row.hour) >= until ||
          !Number.isSafeInteger(row.requests) || row.requests <= 0) continue;
        const dimensions = telemetryModelDimensions(row.provider, row.model);
        const key = JSON.stringify([row.hour, dimensions.provider, dimensions.model]);
        const previous = grouped.get(key);
        if (previous) previous.requests += row.requests;
        else grouped.set(key, { uuid: randomUUID(), bucket: row.hour, ...dimensions, requests: row.requests });
      }
      models.pending = { cadence: "hourly", until, rows: [...grouped.values()] };
      this.dirty = true;
      this.save();
    }
    const pending = models.pending;
    if (!pending) return;
    while (pending.rows.length > 0 && this.current(generation)) {
      const rows = pending.rows.slice(0, BATCH_SIZE);
      const accepted = await this.send(rows.map((row) => ({
        uuid: row.uuid,
        event: pending.cadence === "daily" ? "model_usage_daily" : "model_usage_hourly",
        distinct_id: ledger.installationId,
        timestamp: new Date(Math.max(Date.parse(row.bucket), models.since)).toISOString(),
        properties: {
          ...this.commonProperties,
          date: row.bucket.slice(0, 10),
          ...(pending.cadence === "hourly" ? { hour: row.bucket } : {}),
          provider: row.provider, model: row.model, requests: row.requests,
        },
      })), generation);
      if (!accepted || !this.current(generation)) return;
      pending.rows.splice(0, rows.length);
      this.dirty = true;
      this.save();
    }
    if (!this.current(generation)) return;
    models.through = pending.until;
    models.pending = null;
    this.dirty = true;
    this.save();
  }

  private warn(): void {
    // Never log request data, identifiers, database paths, or network error details.
    console.warn("[usage-telemetry] Report unavailable; app operation is unaffected.");
  }
}
