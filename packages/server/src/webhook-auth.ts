import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { WebhookAuth } from "@omp-ui/core/webhook";
import { tokenMatches } from "./token";

/**
 * Webhook delivery authentication (issue #997, ADR-0075). Separate from the
 * remote credential on purpose: a webhook secret never opens the app, and the
 * remote token never authenticates a delivery.
 */

/** 128 random bits, base64url: an address, not a credential. */
export function mintWebhookId(): string {
  return randomBytes(16).toString("base64url");
}

/** 256 random bits, base64url. */
export function mintWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0]! : null;
  return typeof value === "string" ? value : null;
}

/** GitHub's `X-Hub-Signature-256` value for `body` under `secret`. */
export function webhookSignature(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * True when the request proves it holds `secret`. HMAC compares decoded
 * digests with timingSafeEqual; bearer goes through tokenMatches (hashed,
 * length-hiding). Neither ever reads a query parameter.
 */
export function verifyWebhookRequest(
  auth: WebhookAuth,
  secret: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
): boolean {
  if (secret === "") return false;
  if (auth === "bearer") {
    const value = header(headers, "authorization");
    const match = value === null ? null : /^Bearer\s+(\S+)\s*$/i.exec(value);
    return match !== null && tokenMatches(secret, match[1]!);
  }
  const value = header(headers, "x-hub-signature-256");
  const match = value === null ? null : /^sha256=([0-9a-fA-F]{64})$/.exec(value.trim());
  if (match === null) return false;
  const given = Buffer.from(match[1]!, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(given, expected);
}
