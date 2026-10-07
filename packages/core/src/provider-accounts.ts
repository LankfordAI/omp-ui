import { isObject } from "./guards";
import type { LoginProvider } from "./provider-catalog";
import type { ProviderCredential } from "./types";
import { RpcClient, type RpcSpawnFn } from "./rpc/client";

/** First omp with `get_logout_accounts`/`logout` (upstream #14588). */
export const LOGOUT_ACCOUNTS_MIN_OMP = "18.7.0";
/** omp's dispatch answer for a verb its build does not know (rpc-mode.ts). */
const UNKNOWN_COMMAND_PREFIX = "Unknown command:";

const ROSTER_ID = "provider-accounts-roster";
const LOGOUT_ID = "provider-accounts-logout";
/** One timer for the whole roster + per-provider errand (issue #779). */
const ERRAND_TIMEOUT_MS = 10_000;

/**
 * Result of one accounts errand: the login roster plus each roster id's stored
 * credentials; `{ ok: false }` when the binary predates `get_logout_accounts`;
 * null on transport failure, meaning "keep the caller's last snapshot".
 */
export type ProviderAccountsRead =
  | { ok: true; providers: LoginProvider[]; accounts: Map<string, ProviderCredential[]> }
  | { ok: false; unsupported: true; providers: LoginProvider[] }
  | null; // transport failure: caller keeps its last snapshot
function parseProviders(data: unknown): LoginProvider[] | null {
  if (!isObject(data) || Array.isArray(data) || !Array.isArray(data.providers)) return null;
  const providers: LoginProvider[] = [];
  for (const provider of data.providers) {
    if (
      !isObject(provider) ||
      Array.isArray(provider) ||
      typeof provider.id !== "string" ||
      provider.id.trim().length === 0 ||
      typeof provider.name !== "string" ||
      provider.name.trim().length === 0 ||
      typeof provider.available !== "boolean" ||
      typeof provider.authenticated !== "boolean"
    ) {
      return null;
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      available: provider.available,
      authenticated: provider.authenticated,
    });
  }
  return providers;
}

/** Strict like the roster parse: any shape violation is a failed read, never a partial map. */
function parseAccounts(data: unknown): ProviderCredential[] | null {
  if (!isObject(data) || Array.isArray(data) || !Array.isArray(data.accounts)) return null;
  const accounts: ProviderCredential[] = [];
  for (const account of data.accounts) {
    if (
      !isObject(account) ||
      Array.isArray(account) ||
      typeof account.credentialId !== "number" ||
      !Number.isSafeInteger(account.credentialId) ||
      account.credentialId <= 0 ||
      typeof account.provider !== "string" ||
      typeof account.label !== "string" ||
      typeof account.detail !== "string" ||
      (account.type !== "oauth" && account.type !== "api_key") ||
      typeof account.active !== "boolean"
    ) {
      return null;
    }
    accounts.push({
      credentialId: account.credentialId,
      provider: account.provider,
      label: account.label,
      detail: account.detail,
      type: account.type,
      active: account.active,
    });
  }
  return accounts;
}

/**
 * Read the login roster and every roster id's stored credentials through one
 * short-lived, session-less child (issue #779): the roster answers first, then
 * one `get_logout_accounts` per unique id. Both verbs resolve login aliases, so
 * an alias row reports its canonical credential (omp's `storeCredentialsAs`).
 */
export function readProviderAccounts(opts: {
  ompPath: string | null;
  scratchDir: string;
  spawnProcess?: RpcSpawnFn;
  signal?: AbortSignal;
}): Promise<ProviderAccountsRead> {
  if (opts.ompPath === null || opts.signal?.aborted) return Promise.resolve(null);
  const ompPath = opts.ompPath;

  // Executor form: the package's ES2022 lib predates Promise.withResolvers.
  return new Promise((resolve) => {
    let client: RpcClient | null = null;
    let settled = false;
    let roster: LoginProvider[] | null = null;
    /** Outstanding accounts responses: rpc id -> roster id it stands for. */
    const pending = new Map<string, string>();
    const accounts = new Map<string, ProviderCredential[]>();
    const settle = (value: ProviderAccountsRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      client?.kill();
      resolve(value);
    };
    const onAbort = (): void => settle(null);
    const timer = setTimeout(() => settle(null), ERRAND_TIMEOUT_MS);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finishAccounts = (): void => {
      // The roster parse ran before phase 2, so roster is non-null here.
      settle({ ok: true, providers: roster ?? [], accounts });
    };

    try {
      client = new RpcClient({
        cwd: opts.scratchDir,
        lineageDir: opts.scratchDir,
        ompPath,
        bare: true,
        initialCommands: [{ type: "get_login_providers", id: ROSTER_ID }],
        spawnProcess: opts.spawnProcess,
        onFrame: (frame) => {
          if (settled || !isObject(frame)) return;
          if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
            client?.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
            return;
          }
          if (frame.type !== "response" || typeof frame.id !== "string") return;
          if (roster === null) {
            if (frame.id !== ROSTER_ID || frame.command !== "get_login_providers") return;
            if (frame.success !== true) return settle(null);
            const providers = parseProviders(frame.data);
            if (providers === null) return settle(null);
            roster = providers;
            // Phase 2: one accounts read per unique roster id, first occurrence wins.
            const seen = new Set<string>();
            for (const [index, provider] of providers.entries()) {
              if (seen.has(provider.id)) continue;
              seen.add(provider.id);
              const id = `provider-accounts-${index}`;
              pending.set(id, provider.id);
              client?.send({ type: "get_logout_accounts", id, providerId: provider.id });
            }
            if (pending.size === 0) finishAccounts();
            return;
          }
          const providerId = pending.get(frame.id);
          if (providerId === undefined) return;
          pending.delete(frame.id);
          if (frame.success !== true) {
            const error = typeof frame.error === "string" ? frame.error : "";
            if (error.startsWith(UNKNOWN_COMMAND_PREFIX)) {
              settle({ ok: false, unsupported: true, providers: roster ?? [] });
            } else {
              settle(null);
            }
            return;
          }
          const entries = parseAccounts(frame.data);
          if (entries === null) return settle(null);
          accounts.set(providerId, entries);
          if (pending.size === 0) finishAccounts();
        },
        onExit: () => settle(null),
        onError: () => settle(null),
      });
      // A synchronous child callback or abort may settle while the constructor runs.
      if (settled) client.kill();
    } catch {
      settle(null);
    }
  });
}

/**
 * Remove exactly one stored credential through omp's rpc `logout` in one bare
 * child. A login alias `providerId` resolves before removal, so signing out of
 * an alias row removes the shared canonical credential (issue #779). Resolves
 * with omp's description of auth that still applies, or null when none does.
 */
export function logoutCredential(opts: {
  ompPath: string;
  providerId: string;
  credentialId: number;
  scratchDir: string;
  spawnProcess?: RpcSpawnFn;
}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let client: RpcClient | null = null;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      client?.kill();
    };
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`sign-out timed out after ${ERRAND_TIMEOUT_MS / 1000} seconds`)),
      ERRAND_TIMEOUT_MS,
    );

    try {
      client = new RpcClient({
        cwd: opts.scratchDir,
        lineageDir: opts.scratchDir,
        ompPath: opts.ompPath,
        bare: true,
        initialCommands: [
          { type: "logout", id: LOGOUT_ID, providerId: opts.providerId, credentialId: opts.credentialId },
        ],
        spawnProcess: opts.spawnProcess,
        onFrame: (frame) => {
          if (settled || !isObject(frame)) return;
          if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
            client?.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
            return;
          }
          if (
            frame.type !== "response" ||
            frame.id !== LOGOUT_ID ||
            frame.command !== "logout"
          ) {
            return;
          }
          if (frame.success === true) {
            const data = frame.data;
            const source = isObject(data) && typeof data.remainingSource === "string" ? data.remainingSource : null;
            settle(source);
            return;
          }
          const error = typeof frame.error === "string" ? frame.error : "sign-out failed";
          fail(
            error.startsWith(UNKNOWN_COMMAND_PREFIX)
              ? new Error(`sign-out requires omp ${LOGOUT_ACCOUNTS_MIN_OMP} or later`)
              : new Error(error),
          );
        },
        onExit: (code) => fail(new Error(`omp exited (${code ?? "signal"}) before signing out`)),
        onError: (msg) => fail(new Error(msg)),
      });
      // A synchronous child callback may settle while the constructor runs.
      if (settled) client.kill();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
