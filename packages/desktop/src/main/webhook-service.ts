/**
 * Webhooks, host side (issue #997, ADR-0075): owns the encrypted store, the
 * delivery audit list, the in-memory rate limits and replay window, and turns
 * an authenticated delivery into one Fleet dispatch with a webhook requester.
 * The server package owns parsing, the body cap, and signature checks; this
 * class never sees a request that failed them except to audit it.
 */
import { randomUUID } from "node:crypto";
import {
  WEBHOOK_DEDUPE_WINDOW,
  WEBHOOK_GLOBAL_PER_HOUR,
  webhookHeaderText,
  webhookPrompt,
  webhookTitle,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type WebhookDelivery,
  type WebhookDeliveryLog,
  type WebhookDeliveryOutcome,
  type WebhookInput,
  type WebhookPatch,
  type WebhookRecord,
  type WebhookSecretReveal,
  type WebhooksState,
  type WebhookStore,
} from "@omp-ui/core";
import {
  mintWebhookId,
  mintWebhookSecret,
  type WebhookAnswer,
  type WebhookIntake,
  type WebhookLookup,
  type WebhookRefusal,
  type WebhookRequestMeta,
} from "@omp-ui/server";

const HOUR_MS = 3_600_000;
/** Webhook deliveries are bounded like an agent dispatch: inside the 60 s host-answer watchdog. */
const WEBHOOK_DISPATCH_DEADLINE_MS = 45_000;

export interface WebhookServiceDeps {
  store: WebhookStore;
  log: WebhookDeliveryLog;
  /** The `webhooksEnabled` setting. */
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** FleetDispatcher.dispatch with the webhook requester. */
  dispatch(req: FleetDispatchRequest, opts: { deadlineMs: number }): Promise<FleetDispatchResult>;
  /** Pushes `webhooks:state` to every client. */
  send(state: WebhooksState): void;
  now?: () => number;
  uuid?: () => string;
}

export class WebhookService implements WebhookIntake {
  readonly #deps: WebhookServiceDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  /** Accepted-delivery timestamps per webhook id, and app-wide; in memory, reset by a restart. */
  readonly #accepted = new Map<string, number[]>();
  #acceptedAll: number[] = [];
  /** Recently seen `X-GitHub-Delivery` ids per webhook, oldest first. */
  readonly #seen: string[] = [];

  constructor(deps: WebhookServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#uuid = deps.uuid ?? randomUUID;
  }

  state(): WebhooksState {
    return {
      enabled: this.#deps.enabled(),
      credentialStore: this.#deps.store.available,
      webhooks: this.#deps.store.list(),
      deliveries: this.#deps.log.list(),
    };
  }

  #publish(): void {
    this.#deps.send(this.state());
  }

  setEnabled(on: boolean): void {
    this.#deps.setEnabled(on);
    this.#publish();
  }

  create(input: WebhookInput): WebhookSecretReveal {
    const secret = mintWebhookSecret();
    const record: WebhookRecord = { id: mintWebhookId(), ...input, createdAt: new Date(this.#now()).toISOString() };
    this.#deps.store.add(record, secret);
    this.#publish();
    return { webhook: { ...record, secretReadable: true }, secret };
  }

  update(id: string, patch: WebhookPatch): void {
    this.#deps.store.update(id, patch);
    this.#publish();
  }

  rotate(id: string): WebhookSecretReveal {
    const secret = mintWebhookSecret();
    this.#deps.store.rotate(id, secret);
    this.#publish();
    const webhook = this.#deps.store.list().find((w) => w.id === id)!;
    return { webhook, secret };
  }

  remove(id: string): void {
    this.#deps.store.remove(id);
    this.#accepted.delete(id);
    this.#publish();
  }

  clearDeliveries(): void {
    this.#deps.log.clear();
    this.#publish();
  }

  // --- WebhookIntake (called by the remote server) ---

  enabled(): boolean {
    return this.#deps.enabled();
  }

  lookup(id: string): WebhookLookup | null {
    const record = this.#deps.store.get(id);
    if (record === null) return null;
    return { auth: record.auth, secret: this.#deps.store.secret(id), enabled: record.enabled };
  }

  refused(id: string, reason: WebhookRefusal, meta: WebhookRequestMeta): void {
    const outcome: WebhookDeliveryOutcome = reason === "too-large" ? "bad-request" : reason;
    const status = reason === "too-large" ? 413 : reason === "bad-request" ? 400 : 401;
    const message = reason === "too-large" ? "body too large" : reason === "bad-request" ? "body is not UTF-8 text" : null;
    this.#record(id, meta, status, outcome, message);
  }

  accept(id: string, meta: WebhookRequestMeta, body: string): WebhookAnswer {
    const record = this.#deps.store.get(id);
    if (record === null) return { status: 401, body: { error: "unauthorized" } };
    const now = this.#now();
    const deliveryKey = meta.deliveryId === null ? null : `${id}\u0000${webhookHeaderText(meta.deliveryId, 128)}`;
    if (deliveryKey !== null && this.#seen.includes(deliveryKey)) {
      this.#record(id, meta, 200, "duplicate", null);
      return { status: 200, body: { duplicate: true } };
    }
    const recent = (this.#accepted.get(id) ?? []).filter((t) => now - t < HOUR_MS);
    this.#acceptedAll = this.#acceptedAll.filter((t) => now - t < HOUR_MS);
    const own = record.ratePerHour !== null && recent.length >= record.ratePerHour ? recent : null;
    const global = this.#acceptedAll.length >= WEBHOOK_GLOBAL_PER_HOUR ? this.#acceptedAll : null;
    const limited = own ?? global;
    if (limited !== null) {
      const retryAfterSeconds = Math.max(1, Math.ceil((limited[0]! + HOUR_MS - now) / 1000));
      this.#accepted.set(id, recent);
      const message = own !== null ? `limit of ${record.ratePerHour} per hour reached` : `app-wide limit of ${WEBHOOK_GLOBAL_PER_HOUR} per hour reached`;
      this.#record(id, meta, 429, "rate-limited", message);
      return { status: 429, body: { error: "rate limited" }, retryAfterSeconds };
    }
    recent.push(now);
    this.#accepted.set(id, recent);
    this.#acceptedAll.push(now);
    if (deliveryKey !== null) {
      this.#seen.push(deliveryKey);
      if (this.#seen.length > WEBHOOK_DEDUPE_WINDOW) this.#seen.splice(0, this.#seen.length - WEBHOOK_DEDUPE_WINDOW);
    }
    const delivery = this.#record(id, meta, 202, "pending", null);
    void this.#start(record, meta, body, delivery.id);
    return { status: 202, body: { delivery: delivery.id } };
  }

  async #start(record: WebhookRecord, meta: WebhookRequestMeta, body: string, deliveryId: string): Promise<void> {
    const event = webhookHeaderText(meta.event, 64);
    const prompt = webhookPrompt({
      template: record.template,
      name: record.name,
      event,
      contentType: webhookHeaderText(meta.contentType, 120),
      bytes: meta.bytes,
      body,
    });
    let patch: Partial<Pick<WebhookDelivery, "outcome" | "tabId" | "message">>;
    try {
      const result = await this.#deps.dispatch(
        {
          targets: { kind: "explicit", picks: [{ machineKey: record.machineKey, projectCwd: record.projectCwd }] },
          prompt,
          title: webhookTitle(record.name, event),
          workspace: record.workspace,
          planMode: record.mode === "plan",
        },
        { deadlineMs: WEBHOOK_DISPATCH_DEADLINE_MS },
      );
      const outcome = result.outcomes[0];
      if (outcome === undefined) patch = { outcome: "failed", message: "no dispatch outcome" };
      else if (outcome.status === "started") patch = { outcome: "started", tabId: outcome.tabId, message: null };
      else patch = { outcome: outcome.status, message: outcome.message };
    } catch (err) {
      patch = { outcome: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (patch.outcome !== "started") console.warn(`[webhooks] ${record.id} delivery ${deliveryId}: ${patch.outcome} — ${patch.message}`);
    this.#deps.log.update(deliveryId, patch);
    this.#publish();
  }

  #record(
    id: string,
    meta: WebhookRequestMeta,
    status: number,
    outcome: WebhookDeliveryOutcome,
    message: string | null,
  ): WebhookDelivery {
    const record = this.#deps.store.get(id);
    const delivery: WebhookDelivery = {
      id: this.#uuid(),
      at: new Date(this.#now()).toISOString(),
      webhookId: id,
      webhookName: record?.name ?? id,
      remoteAddress: webhookHeaderText(meta.remoteAddress, 64) ?? "?",
      event: webhookHeaderText(meta.event, 64),
      bytes: meta.bytes,
      status,
      outcome,
      tabId: null,
      machineKey: record?.machineKey ?? "",
      message,
    };
    this.#deps.log.record(delivery);
    this.#publish();
    return delivery;
  }
}
