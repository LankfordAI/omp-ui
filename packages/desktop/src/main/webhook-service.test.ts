import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  WEBHOOK_GLOBAL_PER_HOUR,
  WebhookDeliveryLog,
  WebhookStore,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type KeyCipher,
  type WebhookInput,
} from "@omp-ui/core";
import type { WebhookRequestMeta } from "@omp-ui/server";
import { WebhookService } from "./webhook-service";

const cipher: KeyCipher = {
  available: true,
  backend: "test",
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (blob) => blob.toString("utf8").slice(4),
};

const INPUT: WebhookInput = {
  name: "Deploys",
  machineKey: "local",
  projectCwd: "/project",
  template: "Investigate the failed deploy.",
  mode: "plan",
  workspace: "worktree",
  auth: "hmac",
  enabled: true,
  ratePerHour: 2,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function make(): {
  service: WebhookService;
  dispatched: FleetDispatchRequest[];
  clock: { now: number };
  settle: () => Promise<void>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-webhook-service-"));
  dirs.push(dir);
  const dispatched: FleetDispatchRequest[] = [];
  const clock = { now: Date.parse("2026-10-30T12:00:00Z") };
  let pending: Promise<unknown> = Promise.resolve();
  let n = 0;
  const service = new WebhookService({
    store: new WebhookStore(path.join(dir, "webhooks.json"), cipher),
    log: new WebhookDeliveryLog(path.join(dir, "webhook-deliveries.json")),
    enabled: () => true,
    setEnabled: () => {},
    dispatch: (req) => {
      dispatched.push(req);
      const result: FleetDispatchResult = {
        batchId: null,
        outcomes: [{ dispatchId: "d", machineKey: "local", projectCwd: "/project", status: "started", tabId: `tab-${dispatched.length}`, choice: { model: null, thinkingLevel: null } }],
      };
      const work = Promise.resolve(result);
      pending = work;
      return work;
    },
    send: () => {},
    now: () => clock.now,
    uuid: () => `id-${++n}`,
  });
  return { service, dispatched, clock, settle: async () => { await pending; await nextTurn(); } };
}

function meta(overrides: Partial<WebhookRequestMeta> = {}): WebhookRequestMeta {
  return { remoteAddress: "127.0.0.1", event: "push", deliveryId: null, contentType: "application/json", bytes: 2, ...overrides };
}

describe("WebhookService", () => {
  it("dispatches one explicit pick with the fenced body and the webhook's mode and workspace", async () => {
    const { service, dispatched, settle } = make();
    const { webhook } = service.create(INPUT);
    const answer = service.accept(webhook.id, meta(), '{"ref":"main"}');
    expect(answer.status).toBe(202);
    await settle();
    expect(dispatched).toHaveLength(1);
    const req = dispatched[0]!;
    expect(req.targets).toEqual({ kind: "explicit", picks: [{ machineKey: "local", projectCwd: "/project" }] });
    expect(req.planMode).toBe(true);
    expect(req.workspace).toBe("worktree");
    expect(req.title).toBe("Deploys · push");
    expect(req.prompt.startsWith("Investigate the failed deploy.")).toBe(true);
    expect(req.prompt).toContain('```untrusted-webhook-body\n{"ref":"main"}\n```');
    const delivery = service.state().deliveries.at(-1)!;
    expect(delivery).toMatchObject({ outcome: "started", tabId: "tab-1", status: 202 });
  });

  it("refuses deliveries over the per-webhook hourly limit until the hour rolls", async () => {
    const { service, dispatched, clock, settle } = make();
    const { webhook } = service.create(INPUT);
    expect(service.accept(webhook.id, meta(), "a").status).toBe(202);
    expect(service.accept(webhook.id, meta(), "b").status).toBe(202);
    const limited = service.accept(webhook.id, meta(), "c");
    expect(limited.status).toBe(429);
    expect(limited.retryAfterSeconds).toBe(3600);
    clock.now += 3_600_001;
    expect(service.accept(webhook.id, meta(), "d").status).toBe(202);
    await settle();
    expect(dispatched).toHaveLength(3);
  });

  it("caps accepted deliveries across all webhooks per hour", () => {
    const { service } = make();
    const { webhook } = service.create({ ...INPUT, ratePerHour: null });
    for (let i = 0; i < WEBHOOK_GLOBAL_PER_HOUR; i += 1) expect(service.accept(webhook.id, meta(), "x").status).toBe(202);
    expect(service.accept(webhook.id, meta(), "x").status).toBe(429);
  });

  it("answers a replayed GitHub delivery id without starting a second session", async () => {
    const { service, dispatched, settle } = make();
    const { webhook } = service.create(INPUT);
    expect(service.accept(webhook.id, meta({ deliveryId: "gh-1" }), "a").status).toBe(202);
    expect(service.accept(webhook.id, meta({ deliveryId: "gh-1" }), "a").status).toBe(200);
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(service.state().deliveries.map((d) => d.outcome)).toEqual(["started", "duplicate"]);
  });

  it("never exposes the secret in its state, and rotation replaces it", () => {
    const { service } = make();
    const created = service.create(INPUT);
    expect(JSON.stringify(service.state())).not.toContain(created.secret);
    const rotated = service.rotate(created.webhook.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(service.lookup(created.webhook.id)?.secret).toBe(rotated.secret);
  });
});
