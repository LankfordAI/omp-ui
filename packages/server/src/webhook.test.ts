import { afterEach, describe, expect, it } from "vitest";
import type { ChannelTable } from "@omp-ui/core";
import { WEBHOOK_BODY_MAX_BYTES } from "@omp-ui/core/webhook";
import {
  startRemoteServer,
  type RemoteServerHandle,
  type WebhookIntake,
  type WebhookLookup,
  type WebhookRefusal,
  type WebhookRequestMeta,
} from "./index";
import { hashRemotePassword, mintRemoteToken } from "./token";
import { mintWebhookId, mintWebhookSecret, webhookSignature } from "./webhook-auth";

const TOKEN = mintRemoteToken();
const ID = mintWebhookId();
const SECRET = mintWebhookSecret();

interface FakeIntake extends WebhookIntake {
  on: boolean;
  hooks: Map<string, WebhookLookup>;
  accepted: Array<{ id: string; meta: WebhookRequestMeta; body: string }>;
  refusals: Array<{ id: string; reason: WebhookRefusal }>;
}

function fakeIntake(lookup: WebhookLookup = { auth: "hmac", secret: SECRET, enabled: true }): FakeIntake {
  const intake: FakeIntake = {
    on: true,
    hooks: new Map([[ID, lookup]]),
    accepted: [],
    refusals: [],
    enabled: () => intake.on,
    lookup: (id) => intake.hooks.get(id) ?? null,
    refused: (id, reason) => {
      intake.refusals.push({ id, reason });
    },
    accept: (id, meta, body) => {
      intake.accepted.push({ id, meta, body });
      return { status: 202, body: { delivery: "d-1" } };
    },
  };
  return intake;
}

const host = {
  handlers: () => ({ request: {}, notify: {} }) as unknown as ChannelTable,
  addSink: () => () => {},
};

const open: RemoteServerHandle[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function serve(intake: FakeIntake, password = false): Promise<string> {
  const handle = await startRemoteServer({
    host,
    token: TOKEN,
    bind: "localhost",
    port: 0,
    webRoot: "/nonexistent-web-root",
    password: password ? hashRemotePassword("correct horse") : null,
    webhooks: intake,
  });
  open.push(handle);
  return `http://127.0.0.1:${handle.port}`;
}

function signed(body: string, secret = SECRET, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": webhookSignature(secret, body), ...extra },
    body,
  };
}

describe("webhook route", () => {
  it("hands an HMAC-signed delivery to the intake with its body and event", async () => {
    const intake = fakeIntake();
    const base = await serve(intake);
    const body = JSON.stringify({ action: "opened" });
    const res = await fetch(`${base}/webhooks/${ID}`, signed(body, SECRET, { "X-GitHub-Event": "pull_request" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ delivery: "d-1" });
    expect(intake.accepted).toHaveLength(1);
    expect(intake.accepted[0]!.body).toBe(body);
    expect(intake.accepted[0]!.meta.event).toBe("pull_request");
  });

  it("refuses a signature made with another secret, and never calls accept", async () => {
    const intake = fakeIntake();
    const base = await serve(intake);
    const res = await fetch(`${base}/webhooks/${ID}`, signed("{}", mintWebhookSecret()));
    expect(res.status).toBe(401);
    expect(intake.accepted).toHaveLength(0);
    expect(intake.refusals).toEqual([{ id: ID, reason: "unauthorized" }]);
  });

  it("refuses a valid signature over a different body", async () => {
    const intake = fakeIntake();
    const base = await serve(intake);
    const init = signed("{\"a\":1}");
    const res = await fetch(`${base}/webhooks/${ID}`, { ...init, body: "{\"a\":2}" });
    expect(res.status).toBe(401);
    expect(intake.accepted).toHaveLength(0);
  });

  it("never accepts the remote token or a token query in place of the webhook secret", async () => {
    const intake = fakeIntake({ auth: "bearer", secret: SECRET, enabled: true });
    const base = await serve(intake);
    const asBearer = await fetch(`${base}/webhooks/${ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    const asQuery = await fetch(`${base}/webhooks/${ID}?t=${encodeURIComponent(TOKEN)}`, { method: "POST", body: "{}" });
    const secretInQuery = await fetch(`${base}/webhooks/${ID}?t=${encodeURIComponent(SECRET)}`, { method: "POST", body: "{}" });
    expect([asBearer.status, asQuery.status, secretInQuery.status]).toEqual([401, 401, 401]);
    expect(intake.accepted).toHaveLength(0);
  });

  it("accepts the bearer secret for a bearer webhook", async () => {
    const intake = fakeIntake({ auth: "bearer", secret: SECRET, enabled: true });
    const base = await serve(intake);
    const res = await fetch(`${base}/webhooks/${ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: "hello",
    });
    expect(res.status).toBe(202);
    expect(intake.accepted[0]!.body).toBe("hello");
  });

  it("answers an unknown id exactly like a bad signature", async () => {
    const intake = fakeIntake();
    const base = await serve(intake);
    const unknown = await fetch(`${base}/webhooks/${mintWebhookId()}`, signed("{}"));
    const bad = await fetch(`${base}/webhooks/${ID}`, signed("{}", mintWebhookSecret()));
    expect(unknown.status).toBe(bad.status);
    expect(await unknown.text()).toBe(await bad.text());
  });

  it("is not a route while the master switch is off: the remote auth wall answers instead", async () => {
    const intake = fakeIntake();
    intake.on = false;
    const base = await serve(intake);
    const res = await fetch(`${base}/webhooks/${ID}`, signed("{}"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(intake.accepted).toHaveLength(0);
    expect(intake.refusals).toHaveLength(0);
  });

  it("refuses a disabled webhook after authenticating it", async () => {
    const intake = fakeIntake({ auth: "hmac", secret: SECRET, enabled: false });
    const base = await serve(intake);
    const res = await fetch(`${base}/webhooks/${ID}`, signed("{}"));
    expect(res.status).toBe(401);
    expect(intake.refusals).toEqual([{ id: ID, reason: "disabled" }]);
  });

  it("refuses an unreadable secret", async () => {
    const intake = fakeIntake({ auth: "hmac", secret: null, enabled: true });
    const base = await serve(intake);
    const res = await fetch(`${base}/webhooks/${ID}`, signed("{}"));
    expect(res.status).toBe(401);
    expect(intake.accepted).toHaveLength(0);
  });

  it("answers 413 for a body over the cap without accepting it", async () => {
    const intake = fakeIntake();
    const base = await serve(intake);
    const body = "x".repeat(WEBHOOK_BODY_MAX_BYTES + 1);
    const res = await fetch(`${base}/webhooks/${ID}`, signed(body));
    expect(res.status).toBe(413);
    expect(intake.accepted).toHaveLength(0);
    expect(intake.refusals.map((r) => r.reason)).toEqual(["too-large"]);
  });

  it("answers 400 for a body that is not UTF-8", async () => {
    const intake = fakeIntake();
    const base = await serve(intake);
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    const res = await fetch(`${base}/webhooks/${ID}`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": webhookSignature(SECRET, bytes) },
      body: bytes,
    });
    expect(res.status).toBe(400);
    expect(intake.accepted).toHaveLength(0);
  });

  it("answers 405 to a GET even in password mode, without redirecting to sign-in", async () => {
    const intake = fakeIntake();
    const base = await serve(intake, true);
    const res = await fetch(`${base}/webhooks/${ID}`, { redirect: "manual" });
    expect(res.status).toBe(405);
  });

  it("passes the intake's Retry-After through", async () => {
    const intake = fakeIntake();
    intake.accept = () => ({ status: 429, body: { error: "rate limited" }, retryAfterSeconds: 120 });
    const base = await serve(intake);
    const res = await fetch(`${base}/webhooks/${ID}`, signed("{}"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
  });
});
