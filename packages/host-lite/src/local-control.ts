import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { RoutinesState } from "@omp-ui/core";
import type { LiteRoutinesControl } from "./seams";

/**
 * OS-user-protected local control endpoint (issue #1368, ADR-0100).
 *
 * Host-local Routines mutations (`enable`, `disable`, `spend`) NEVER sit on
 * `LiteBackend`'s LAN WebSocket table. Instead, `omp-ui-lite serve` listens
 * on an OS-user-only local endpoint inside the 0700 data dir:
 *  - POSIX: Unix domain socket `<dataDir>/control.sock` chmodded `0600`.
 *  - Windows: loopback-only ephemeral HTTP (`127.0.0.1:0`) paired with a
 *    `0600` `<dataDir>/control.json` holding `{ port, secret }`.
 */

const MAX_BODY_BYTES = 16 * 1024;
const CLIENT_TIMEOUT_MS = 5_000;
const CONTROL_SOCK_NAME = "control.sock";
const CONTROL_JSON_NAME = "control.json";

export interface LocalControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface LocalControlSpendPatch {
  warnUsd?: number;
  maxUsd?: number;
}

export class LocalControlHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "LocalControlHttpError";
    this.statusCode = statusCode;
  }
}

export class LocalControlUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalControlUnavailableError";
  }
}

export function controlSocketPath(dataDir: string): string {
  return path.join(dataDir, CONTROL_SOCK_NAME);
}

export function controlMetadataPath(dataDir: string): string {
  return path.join(dataDir, CONTROL_JSON_NAME);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new LocalControlHttpError(413, "request body too large");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalControlHttpError(400, "invalid JSON body");
  }
}

function parseOptionalSpendPatch(raw: unknown): LocalControlSpendPatch {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new LocalControlHttpError(400, "request body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "warnUsd" && key !== "maxUsd") {
      throw new LocalControlHttpError(400, `unknown field "${key}"`);
    }
  }
  const patch: LocalControlSpendPatch = {};
  if (obj.warnUsd !== undefined) {
    if (typeof obj.warnUsd !== "number" || !Number.isFinite(obj.warnUsd)) {
      throw new LocalControlHttpError(400, "warnUsd must be a finite number");
    }
    patch.warnUsd = obj.warnUsd;
  }
  if (obj.maxUsd !== undefined) {
    if (typeof obj.maxUsd !== "number" || !Number.isFinite(obj.maxUsd)) {
      throw new LocalControlHttpError(400, "maxUsd must be a finite number");
    }
    patch.maxUsd = obj.maxUsd;
  }
  return patch;
}

function isDisabledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("disabled");
}

function isValidationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("warnUsd") || msg.includes("maxUsd") || msg.includes("routine spend defaults");
}

function verifySecret(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
  const target = Buffer.from(expected, "utf8");
  if (presented.length !== target.length) return false;
  return timingSafeEqual(presented, target);
}

/**
 * Starts the OS-local control server inside `dataDir`. Call only AFTER holding
 * `DataDirLock`, so unlinking any stale `control.sock` is safe.
 */
export async function startLocalControlServer(opts: {
  dataDir: string;
  routinesControl?: LiteRoutinesControl;
  platform?: NodeJS.Platform;
}): Promise<LocalControlServer> {
  const platform = opts.platform ?? process.platform;
  const winSecret = platform === "win32" ? randomBytes(32).toString("hex") : null;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (winSecret !== null && !verifySecret(req.headers.authorization, winSecret)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const control = opts.routinesControl;
        const method = req.method ?? "GET";
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

        if (control === undefined) {
          sendJson(res, 501, { error: "routines control is not available on this session seam" });
          return;
        }

        if (method === "GET" && pathname === "/routines/status") {
          sendJson(res, 200, control.state());
          return;
        }
        if (method === "POST" && pathname === "/routines/enable") {
          const patch = parseOptionalSpendPatch(await readJsonBody(req));
          const state = await control.enable(patch);
          sendJson(res, 200, state);
          return;
        }
        if (method === "POST" && pathname === "/routines/disable") {
          await readJsonBody(req);
          const state = await control.disable();
          sendJson(res, 200, state);
          return;
        }
        if (method === "POST" && pathname === "/routines/spend") {
          const patch = parseOptionalSpendPatch(await readJsonBody(req));
          if (patch.warnUsd === undefined && patch.maxUsd === undefined) {
            sendJson(res, 400, { error: "spend requires at least one of warnUsd or maxUsd" });
            return;
          }
          const state = await control.setSpendDefaults(patch);
          sendJson(res, 200, state);
          return;
        }
        sendJson(res, 404, { error: `unknown control route ${method} ${pathname}` });
      } catch (err) {
        if (err instanceof LocalControlHttpError) {
          sendJson(res, err.statusCode, { error: err.message });
          return;
        }
        if (isDisabledError(err)) {
          sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        if (isValidationError(err)) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  if (platform === "win32") {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", listening.reject);
      listening.resolve();
    });
    await listening.promise;
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const metaPath = controlMetadataPath(opts.dataDir);
    fs.writeFileSync(metaPath, `${JSON.stringify({ port, secret: winSecret })}\n`, { mode: 0o600 });
    let closed = false;
    return {
      endpoint: `http://127.0.0.1:${port}`,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          fs.unlinkSync(metaPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn(`[host-lite] failed to unlink ${metaPath}:`, err);
          }
        }
        const done = Promise.withResolvers<void>();
        server.close(() => done.resolve());
        await done.promise;
      },
    };
  }

  const sockPath = controlSocketPath(opts.dataDir);
  try {
    fs.unlinkSync(sockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(sockPath, () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  fs.chmodSync(sockPath, 0o600);

  let closed = false;
  return {
    endpoint: sockPath,
    close: async () => {
      if (closed) return;
      closed = true;
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      await done.promise;
      try {
        fs.unlinkSync(sockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[host-lite] failed to unlink ${sockPath}:`, err);
        }
      }
    },
  };
}

export interface LocalControlRequestOptions {
  dataDir: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * Calls the live daemon's OS-local control endpoint.
 * Throws `LocalControlUnavailableError` when no live endpoint answers (absent
 * socket/metadata, ECONNREFUSED, ENOENT, timeout), and `LocalControlHttpError`
 * when the live daemon explicitly answered with a non-2xx HTTP status.
 */
export async function requestLocalControl<T>(opts: LocalControlRequestOptions): Promise<T> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? CLIENT_TIMEOUT_MS;
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);

  let reqOpts: http.RequestOptions;
  if (platform === "win32") {
    const metaPath = controlMetadataPath(opts.dataDir);
    let parsed: { port?: unknown; secret?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { port?: unknown; secret?: unknown };
    } catch (err) {
      throw new LocalControlUnavailableError("local control metadata unavailable", err);
    }
    if (typeof parsed.port !== "number" || typeof parsed.secret !== "string") {
      throw new LocalControlUnavailableError("local control metadata malformed");
    }
    reqOpts = {
      hostname: "127.0.0.1",
      port: parsed.port,
      path: opts.path,
      method: opts.method,
      headers: {
        authorization: `Bearer ${parsed.secret}`,
        ...(payload === null
          ? {}
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }),
      },
    };
  } else {
    const sockPath = controlSocketPath(opts.dataDir);
    if (!fs.existsSync(sockPath)) {
      throw new LocalControlUnavailableError(`local control socket absent at ${sockPath}`);
    }
    reqOpts = {
      socketPath: sockPath,
      path: opts.path,
      method: opts.method,
      headers:
        payload === null
          ? {}
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            },
    };
  }

  const settled = Promise.withResolvers<T>();
  const req = http.request(reqOpts, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const status = res.statusCode ?? 500;
      let parsed: unknown = null;
      if (text.trim() !== "") {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          // Fall through with raw text below.
        }
      }
      if (status >= 200 && status < 300) {
        settled.resolve(parsed as T);
        return;
      }
      const message =
        parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
          ? parsed.error
          : text.trim() || `HTTP ${status}`;
      settled.reject(new LocalControlHttpError(status, message));
    });
    res.on("error", (err) => settled.reject(new LocalControlUnavailableError(err.message, err)));
  });
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error("local control request timed out"));
  });
  req.on("error", (err) => {
    settled.reject(new LocalControlUnavailableError(err.message, err));
  });
  if (payload !== null) req.write(payload);
  req.end();
  return settled.promise;
}

export function fetchLocalRoutinesStatus(dataDir: string, platform?: NodeJS.Platform): Promise<RoutinesState> {
  return requestLocalControl<RoutinesState>({
    dataDir,
    method: "GET",
    path: "/routines/status",
    platform,
  });
}

export function enableLocalRoutines(
  dataDir: string,
  caps: LocalControlSpendPatch = {},
  platform?: NodeJS.Platform,
): Promise<RoutinesState> {
  return requestLocalControl<RoutinesState>({
    dataDir,
    method: "POST",
    path: "/routines/enable",
    body: caps,
    platform,
  });
}

export function disableLocalRoutines(dataDir: string, platform?: NodeJS.Platform): Promise<RoutinesState> {
  return requestLocalControl<RoutinesState>({
    dataDir,
    method: "POST",
    path: "/routines/disable",
    body: {},
    platform,
  });
}

export function setLocalRoutineSpend(
  dataDir: string,
  caps: LocalControlSpendPatch,
  platform?: NodeJS.Platform,
): Promise<RoutinesState> {
  return requestLocalControl<RoutinesState>({
    dataDir,
    method: "POST",
    path: "/routines/spend",
    body: caps,
    platform,
  });
}
