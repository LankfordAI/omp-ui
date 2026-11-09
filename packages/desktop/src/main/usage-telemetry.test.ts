import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryModelUsageRow } from "@omp-ui/core";
import { UsageTelemetry, type UsageTelemetryDependencies } from "./usage-telemetry";

interface Event {
  event: string;
  uuid: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}
const roots: string[] = [];
const reporters: UsageTelemetry[] = [];
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(patch: Partial<UsageTelemetryDependencies> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-telemetry-"));
  roots.push(root);
  let now = Date.parse("2026-11-07T12:00:00Z");
  let active = true;
  let modelUsageEnabled = false;
  const batches: Event[][] = [];
  const readModels = vi.fn<UsageTelemetryDependencies["readModels"]>(async () => []);
  const deps: UsageTelemetryDependencies = {
    enabled: true,
    ledgerFile: path.join(root, "usage-telemetry.json"),
    appVersion: "0.33.0",
    modelUsageEnabled: () => modelUsageEnabled,
    isActive: () => active,
    readModels,
    now: () => now,
    fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      const payload: { batch: Event[] } = JSON.parse(init!.body as string);
      batches.push(payload.batch);
      return new Response("", { status: 200 });
    }),
    ...patch,
  };
  const create = () => {
    const reporter = new UsageTelemetry(deps);
    reporters.push(reporter);
    return reporter;
  };
  const reporter = create();
  return {
    deps, reporter, create, batches, readModels,
    setModelUsageEnabled(value: boolean) { modelUsageEnabled = value; },
    setActive(value: boolean) { active = value; },
    setNow(value: string) { now = Date.parse(value); },
  };
}

describe("UsageTelemetry required activity and optional model usage", () => {
  it("does not create an identity, collect, or send from development builds", async () => {
    const h = harness({ enabled: false });
    h.setModelUsageEnabled(true);
    h.reporter.start();
    await h.reporter.poll();
    expect(fs.existsSync(h.deps.ledgerFile)).toBe(false);
    expect(h.readModels).not.toHaveBeenCalled();
    expect(h.batches).toEqual([]);
  });

  it("counts foreground hours once across focus, concurrent polls, restarts, and clock rollback", async () => {
    const h = harness();
    h.reporter.start();
    await Promise.all([h.reporter.poll(), h.reporter.poll(), h.reporter.poll()]);
    const first = h.batches[0]![0]!;
    h.setNow("2026-11-07T12:59:59Z");
    await h.reporter.poll();
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    expect(h.batches.flat().map((event) => event.timestamp)).toEqual(["2026-11-07T12:00:00.000Z"]);
    h.setNow("2026-11-07T13:00:00Z");
    h.setActive(false);
    await restarted.poll();
    expect(h.batches.flat()).toHaveLength(1);
    h.setActive(true);
    await restarted.poll();
    h.setNow("2026-11-07T12:30:00Z");
    await restarted.poll();
    h.setNow("2026-11-07T13:30:00Z");
    await restarted.poll();
    expect(h.batches.flat().map((event) => [event.distinct_id, event.timestamp])).toEqual([
      [first.distinct_id, "2026-11-07T12:00:00.000Z"], [first.distinct_id, "2026-11-07T13:00:00.000Z"],
    ]);
    expect(h.readModels).not.toHaveBeenCalled();
  });

  it("retries the identical frozen event after an ambiguous delivery and restart", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const payloads: string[] = [];
    const h = harness({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      payloads.push(init!.body as string);
      if (payloads.length === 1) throw new Error("Connection lost after ingestion");
      return new Response("", { status: 200 });
    }) });
    h.reporter.start();
    await h.reporter.poll();
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    await restarted.poll();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).app.pending).toBe(null);
  });

  it("reports closed post-consent hours separately, coalesces private names, and never re-exports a snapshot", async () => {
    const h = harness();
    h.setNow("2026-11-07T12:30:00Z");
    h.readModels.mockResolvedValue([
      { hour: "2026-11-07T12:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 7, inputTokens: 70, outputTokens: 30 },
      { hour: "2026-11-07T12:00:00.000Z", provider: "openai", model: "private-deployment-A", requests: 3, inputTokens: 10, outputTokens: 5 },
      { hour: "2026-11-07T12:00:00.000Z", provider: "openai", model: "private-deployment-B", requests: 4, inputTokens: 20, outputTokens: 10 },
      { hour: "2026-11-07T12:00:00.000Z", provider: "internal-company-route", model: "gpt-4o", requests: 2, inputTokens: 8, outputTokens: 4 },
      { hour: "2026-11-07T14:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 5, inputTokens: 50, outputTokens: 25 },
      { hour: "2026-11-07T11:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 99, inputTokens: 99, outputTokens: 99 },
      { hour: "2026-11-07T15:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 99, inputTokens: 99, outputTokens: 99 },
      { hour: "2026-11-07T13:15:00.000Z", provider: "openai", model: "gpt-4o", requests: 99, inputTokens: 99, outputTokens: 99 },
    ]);
    h.setActive(false);
    h.setModelUsageEnabled(true);
    h.reporter.start();
    await h.reporter.poll();
    expect(h.readModels).not.toHaveBeenCalled();
    expect(h.batches).toEqual([]);
    h.setNow("2026-11-07T15:01:00Z");
    await h.reporter.poll();
    expect(h.readModels).toHaveBeenCalledExactlyOnceWith(
      Date.parse("2026-11-07T12:30:00Z"), Date.parse("2026-11-07T15:00:00Z"),
    );
    const events = h.batches.flat();
    expect(events.map((event) => [event.event, event.properties.hour, event.properties.provider, event.properties.model, event.properties.requests])).toEqual([
      ["model_usage_hourly", "2026-11-07T12:00:00.000Z", "openai", "gpt-4o", 7],
      ["model_usage_hourly", "2026-11-07T12:00:00.000Z", "openai", "custom/other", 7],
      ["model_usage_hourly", "2026-11-07T12:00:00.000Z", "custom/other", "custom/other", 2],
      ["model_usage_hourly", "2026-11-07T14:00:00.000Z", "openai", "gpt-4o", 5],
    ]);
    // Coalesced private rows merge token sums exactly like requests; total is
    // the input+output pair computed at send time.
    expect(events.map((event) => [event.properties.input_tokens, event.properties.output_tokens, event.properties.total_tokens])).toEqual([
      [70, 30, 100],
      [30, 15, 45],
      [8, 4, 12],
      [50, 25, 75],
    ]);
    expect(events.map((event) => event.timestamp)).toEqual([
      "2026-11-07T12:30:00.000Z", "2026-11-07T12:30:00.000Z", "2026-11-07T12:30:00.000Z", "2026-11-07T14:00:00.000Z",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private-deployment");
    expect(serialized).not.toContain("internal-company-route");
    expect(events.every((event) =>
      event.properties.$process_person_profile === false && !("$geoip_disable" in event.properties),
    )).toBe(true);
    await h.reporter.poll();
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    expect(h.batches.flat()).toEqual(events);
    expect(h.readModels).toHaveBeenCalledTimes(1);
  });

  it("does not advance an unavailable Stats snapshot or reuse a disabled consent window", async () => {
    const h = harness();
    h.setActive(false);
    h.setModelUsageEnabled(true);
    h.readModels.mockResolvedValue(null);
    h.reporter.start();
    await h.reporter.poll();
    h.setNow("2026-11-07T13:01:00Z");
    await h.reporter.poll();
    expect(JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).models.through).toBe(Date.parse("2026-11-07T12:00:00Z"));
    const installationId = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).installationId;
    h.setModelUsageEnabled(false);
    h.reporter.syncConsent();
    const revoked = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8"));
    expect(revoked.models).toBe(null);
    expect(revoked.installationId).toBe(installationId);
    h.setNow("2026-11-09T13:00:00Z");
    h.setModelUsageEnabled(true);
    h.reporter.syncConsent();
    await h.reporter.poll();
    h.readModels.mockResolvedValue([]);
    h.setNow("2026-11-09T14:01:00Z");
    await h.reporter.poll();
    expect(h.readModels).toHaveBeenLastCalledWith(
      Date.parse("2026-11-09T13:00:00Z"), Date.parse("2026-11-09T14:00:00Z"),
    );
    expect(h.batches).toEqual([]);
  });

  it("drops a model snapshot if consent is revoked while its read is in flight", async () => {
    const h = harness();
    const snapshot = Promise.withResolvers<TelemetryModelUsageRow[] | null>();
    h.readModels.mockReturnValue(snapshot.promise);
    h.setActive(false);
    h.setModelUsageEnabled(true);
    h.reporter.start();
    await h.reporter.poll();
    h.setNow("2026-11-07T13:01:00Z");
    const running = h.reporter.poll();
    h.setModelUsageEnabled(false);
    h.reporter.syncConsent();
    snapshot.resolve([{ hour: "2026-11-07T12:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 9, inputTokens: 40, outputTokens: 20 }]);
    await running;
    expect(h.batches).toEqual([]);
    expect(JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).models).toBe(null);
  });

  it("aborts in-flight model delivery immediately on revocation without dropping the activity identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const h = harness({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      signal = init!.signal as AbortSignal;
      const pending = Promise.withResolvers<Response>();
      signal.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
      started.resolve();
      return pending.promise;
    }) });
    h.setActive(false);
    h.setModelUsageEnabled(true);
    h.readModels.mockResolvedValue([{ hour: "2026-11-07T12:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 3, inputTokens: 15, outputTokens: 9 }]);
    h.reporter.start();
    await h.reporter.poll();
    const installationId = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).installationId;
    h.setNow("2026-11-07T13:01:00Z");
    const running = h.reporter.poll();
    await started.promise;
    expect(signal?.aborted).toBe(false);
    h.setModelUsageEnabled(false);
    h.reporter.syncConsent();
    expect(signal?.aborted).toBe(true);
    await running;
    const ledger = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8"));
    expect(ledger.installationId).toBe(installationId);
    expect(ledger.models).toBe(null);
  });

  it("continues required activity with the same identity after optional model consent is revoked", async () => {
    const h = harness();
    h.reporter.start();
    await h.reporter.poll();
    const installationId = h.batches[0]![0]!.distinct_id;
    h.setModelUsageEnabled(true);
    h.reporter.syncConsent();
    await h.reporter.poll();
    h.setModelUsageEnabled(false);
    h.reporter.syncConsent();
    await h.reporter.poll();
    h.setNow("2026-11-07T13:00:00Z");
    await h.reporter.poll();
    expect(h.batches.flat().map((event) => [event.event, event.distinct_id, event.timestamp])).toEqual([
      ["app_active", installationId, "2026-11-07T12:00:00.000Z"],
      ["app_active", installationId, "2026-11-07T13:00:00.000Z"],
    ]);
    expect(h.readModels).not.toHaveBeenCalled();
  });

  it("migrates daily checkpoints without replaying acknowledged requests or resetting identity", async () => {
    const h = harness();
    const installationId = "11111111-1111-4111-8111-111111111111";
    h.setModelUsageEnabled(true);
    fs.writeFileSync(h.deps.ledgerFile, JSON.stringify({
      version: 1, installationId, app: { lastDay: "2026-11-07", pending: null },
      models: { since: Date.parse("2026-11-06T15:30:00Z"), through: Date.parse("2026-11-07T00:00:00Z"), pending: null },
    }));
    h.readModels.mockResolvedValue([{ hour: "2026-11-07T11:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 2, inputTokens: 12, outputTokens: 6 }]);
    h.reporter.start();
    await h.reporter.poll();
    expect(h.readModels).toHaveBeenCalledExactlyOnceWith(Date.parse("2026-11-07T00:00:00Z"), Date.parse("2026-11-07T12:00:00Z"));
    expect(h.batches.flat().map((event) => [event.event, event.distinct_id, event.properties.requests, event.properties.total_tokens])).toEqual([
      ["app_active", installationId, undefined, undefined], ["model_usage_hourly", installationId, 2, 18],
    ]);
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    expect(h.batches.flat()).toHaveLength(2);
    expect(h.readModels).toHaveBeenCalledTimes(1);
    const ledger = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8"));
    expect(ledger.version).toBe(2);
    expect(ledger.installationId).toBe(installationId);
    expect(ledger.models.since).toBe(Date.parse("2026-11-06T15:30:00Z"));
  });

  it("finishes frozen daily retries with unchanged identities before continuing from their checkpoint hourly", async () => {
    const sent: Event[][] = [];
    let dailyAttempts = 0;
    const h = harness({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      const batch: Event[] = JSON.parse(init!.body as string).batch;
      sent.push(batch);
      const failed = batch[0]!.event === "model_usage_daily" && dailyAttempts++ === 0;
      return new Response("", { status: failed ? 503 : 200 });
    }) });
    h.setActive(false);
    h.setModelUsageEnabled(true);
    const installationId = "11111111-1111-4111-8111-111111111111";
    const activityId = "22222222-2222-4222-8222-222222222222";
    const modelId = "33333333-3333-4333-8333-333333333333";
    fs.writeFileSync(h.deps.ledgerFile, JSON.stringify({
      version: 1, installationId,
      app: { lastDay: "2026-11-05", pending: { uuid: activityId, date: "2026-11-06", timestamp: Date.parse("2026-11-06T22:15:00Z") } },
      models: {
        since: Date.parse("2026-11-06T15:30:00Z"), through: Date.parse("2026-11-06T15:30:00Z"),
        pending: { until: Date.parse("2026-11-07T00:00:00Z"), rows: [
          { uuid: modelId, date: "2026-11-06", provider: "openai", model: "gpt-4o", requests: 8, privatePath: "/never/upload" },
        ] },
      },
    }));
    h.reporter.start();
    await h.reporter.poll();
    expect(sent[0]![0]).toMatchObject({ uuid: activityId, distinct_id: installationId, timestamp: "2026-11-06T22:15:00.000Z" });
    expect(h.readModels).not.toHaveBeenCalled();
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    expect(sent[2]).toEqual(sent[1]);
    expect(sent[2]![0]).toMatchObject({
      event: "model_usage_daily", uuid: modelId, distinct_id: installationId, timestamp: "2026-11-06T15:30:00.000Z",
      properties: { date: "2026-11-06", requests: 8 },
    });
    expect(sent[2]![0]!.properties).not.toHaveProperty("hour");
    expect(JSON.stringify(sent)).not.toContain("/never/upload");
    h.readModels.mockResolvedValue([{ hour: "2026-11-07T11:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 3, inputTokens: 9, outputTokens: 3 }]);
    await restarted.poll();
    expect(h.readModels).toHaveBeenCalledExactlyOnceWith(Date.parse("2026-11-07T00:00:00Z"), Date.parse("2026-11-07T12:00:00Z"));
    expect(sent[3]![0]).toMatchObject({ event: "model_usage_hourly", distinct_id: installationId, properties: { hour: "2026-11-07T11:00:00.000Z", requests: 3, total_tokens: 12 } });
    await restarted.poll();
    expect(sent.map((batch) => batch[0]!.event)).toEqual(["app_active", "model_usage_daily", "model_usage_daily", "model_usage_hourly"]);
  });

  it("retries an hourly model snapshot unchanged across restart without collecting it twice", async () => {
    const payloads: string[] = [];
    const h = harness({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      payloads.push(init!.body as string);
      return new Response("", { status: payloads.length === 1 ? 503 : 200 });
    }) });
    h.setActive(false);
    h.setModelUsageEnabled(true);
    h.readModels.mockResolvedValue([{ hour: "2026-11-07T12:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 4, inputTokens: 16, outputTokens: 8 }]);
    h.reporter.start();
    await h.reporter.poll();
    h.setNow("2026-11-07T13:01:00Z");
    await h.reporter.poll();
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    await restarted.poll();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(JSON.parse(payloads[1]!).batch[0]).toMatchObject({ event: "model_usage_hourly", properties: { hour: "2026-11-07T12:00:00.000Z", requests: 4, input_tokens: 16, output_tokens: 8, total_tokens: 24 } });
    expect(h.readModels).toHaveBeenCalledTimes(1);
  });

  it("drains legacy version-2 pending hourly rows without token fields and keeps the identity", async () => {
    const h = harness();
    h.setActive(false);
    h.setModelUsageEnabled(true);
    const installationId = "11111111-1111-4111-8111-111111111111";
    const modelId = "33333333-3333-4333-8333-333333333333";
    // Written exactly as the pre-token build persisted it: version 2, hourly
    // pending rows with no token fields at all.
    fs.writeFileSync(h.deps.ledgerFile, JSON.stringify({
      version: 2, installationId, app: { lastHour: null, pending: null },
      models: {
        since: Date.parse("2026-11-07T00:00:00Z"), through: Date.parse("2026-11-07T12:00:00Z"),
        pending: { cadence: "hourly", until: Date.parse("2026-11-07T13:00:00Z"), rows: [
          { uuid: modelId, bucket: "2026-11-07T12:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 6 },
        ] },
      },
    }));
    h.reporter.start();
    await h.reporter.poll();
    const events = h.batches.flat();
    expect(events.map((event) => [event.event, event.uuid])).toEqual([["model_usage_hourly", modelId]]);
    expect(events[0]!.distinct_id).toBe(installationId);
    expect(events[0]!.properties).not.toHaveProperty("input_tokens");
    expect(events[0]!.properties).not.toHaveProperty("output_tokens");
    expect(events[0]!.properties).not.toHaveProperty("total_tokens");
    expect(events[0]!.properties.requests).toBe(6);
    const ledger = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8"));
    expect(ledger.version).toBe(2);
    expect(ledger.installationId).toBe(installationId);
  });

  it("rejects a pending row carrying only one token field instead of half-reporting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.setActive(false);
    h.setModelUsageEnabled(true);
    const installationId = "11111111-1111-4111-8111-111111111111";
    fs.writeFileSync(h.deps.ledgerFile, JSON.stringify({
      version: 2, installationId, app: { lastHour: null, pending: null },
      models: {
        since: Date.parse("2026-11-07T00:00:00Z"), through: Date.parse("2026-11-07T12:00:00Z"),
        pending: { cadence: "hourly", until: Date.parse("2026-11-07T13:00:00Z"), rows: [
          { uuid: "33333333-3333-4333-8333-333333333333", bucket: "2026-11-07T12:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 6, inputTokens: 40 },
        ] },
      },
    }));
    h.reporter.start();
    await h.reporter.poll();
    // A corrupt ledger starts fresh: the half-token row is never sent.
    expect(h.batches.flat().map((event) => event.event)).toEqual([]);
    const ledger = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8"));
    expect(ledger.installationId).not.toBe(installationId);
    expect(ledger.models.pending).toBe(null);
  });

  it("bounds an unresponsive request instead of holding shutdown or app operation", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let aborted = false;
    const h = harness({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      const pending = Promise.withResolvers<Response>();
      init!.signal!.addEventListener("abort", () => { aborted = true; pending.reject(new Error("aborted")); }, { once: true });
      return pending.promise;
    }) });
    h.reporter.start();
    const running = h.reporter.poll();
    await vi.advanceTimersByTimeAsync(5_000);
    await running;
    expect(aborted).toBe(true);
    expect(JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).app.pending.date).toBe("2026-11-07");
  });
});
