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

  it("automatically counts foreground days with optional sharing off, once across focus, concurrent polls, and restarts", async () => {
    const h = harness();
    h.reporter.start();
    await Promise.all([h.reporter.poll(), h.reporter.poll(), h.reporter.poll()]);
    const first = h.batches[0]![0]!;
    expect(h.batches.flat().map((event) => event.properties.date)).toEqual(["2026-11-07"]);
    h.reporter.dispose();
    const restarted = h.create();
    restarted.start();
    await restarted.poll();
    expect(h.batches.flat()).toHaveLength(1);
    h.setNow("2026-11-08T12:00:00Z");
    h.setActive(false);
    await restarted.poll();
    expect(h.batches.flat()).toHaveLength(1);
    h.setActive(true);
    await restarted.poll();
    expect(h.batches.flat().map((event) => [event.distinct_id, event.properties.date])).toEqual([
      [first.distinct_id, "2026-11-07"], [first.distinct_id, "2026-11-08"],
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

  it("reports only closed post-consent model days, coalesces private names, and never re-exports a snapshot", async () => {
    const h = harness();
    h.readModels.mockResolvedValue([
      { date: "2026-11-07", provider: "openai", model: "gpt-4o", requests: 7 },
      { date: "2026-11-07", provider: "openai", model: "private-deployment-A", requests: 3 },
      { date: "2026-11-07", provider: "openai", model: "private-deployment-B", requests: 4 },
      { date: "2026-11-07", provider: "internal-company-route", model: "gpt-4o", requests: 2 },
    ]);
    h.setActive(false);
    h.setModelUsageEnabled(true);
    h.reporter.start();
    await h.reporter.poll();
    expect(h.readModels).not.toHaveBeenCalled();
    expect(h.batches).toEqual([]);
    h.setNow("2026-11-08T01:00:00Z");
    await h.reporter.poll();
    expect(h.readModels).toHaveBeenCalledExactlyOnceWith(
      Date.parse("2026-11-07T12:00:00Z"), Date.parse("2026-11-08T00:00:00Z"),
    );
    const events = h.batches.flat();
    expect(events.map((event) => [event.event, event.properties.provider, event.properties.model, event.properties.requests])).toEqual([
      ["model_usage_daily", "openai", "gpt-4o", 7],
      ["model_usage_daily", "openai", "custom/other", 7],
      ["model_usage_daily", "custom/other", "custom/other", 2],
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private-deployment");
    expect(serialized).not.toContain("internal-company-route");
    expect(events.every((event) => event.properties.$process_person_profile === false && event.properties.$geoip_disable === true)).toBe(true);
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
    h.setNow("2026-11-08T01:00:00Z");
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
    h.setNow("2026-11-10T01:00:00Z");
    await h.reporter.poll();
    expect(h.readModels).toHaveBeenLastCalledWith(
      Date.parse("2026-11-09T13:00:00Z"), Date.parse("2026-11-10T00:00:00Z"),
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
    h.setNow("2026-11-08T01:00:00Z");
    const running = h.reporter.poll();
    h.setModelUsageEnabled(false);
    h.reporter.syncConsent();
    snapshot.resolve([{ date: "2026-11-07", provider: "openai", model: "gpt-4o", requests: 9 }]);
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
    h.readModels.mockResolvedValue([{ date: "2026-11-07", provider: "openai", model: "gpt-4o", requests: 3 }]);
    h.reporter.start();
    await h.reporter.poll();
    const installationId = JSON.parse(fs.readFileSync(h.deps.ledgerFile, "utf8")).installationId;
    h.setNow("2026-11-08T01:00:00Z");
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
    h.setNow("2026-11-08T12:00:00Z");
    await h.reporter.poll();
    expect(h.batches.flat().map((event) => [event.event, event.distinct_id, event.properties.date])).toEqual([
      ["app_active", installationId, "2026-11-07"],
      ["app_active", installationId, "2026-11-08"],
    ]);
    expect(h.readModels).not.toHaveBeenCalled();
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
